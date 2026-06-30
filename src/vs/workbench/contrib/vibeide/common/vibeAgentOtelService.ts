/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeAgentOtelService — OTLP trace export for the agent cycle in IDE.
 *
 * Extends the spirit of `vibe run --otel-endpoint` into the IDE itself:
 * - Captures spans for tool-calls, LLM round-trips, context size, latency
 * - Exports as OTLP JSON to a configurable local endpoint (Datadog/Grafana/Jaeger)
 * - Local by default: no data leaves machine unless user explicitly sets an endpoint
 * - Privacy: file paths reduced to basenames; model keys redacted; no prompt content in spans
 *
 * Integration points:
 *  - chatThreadService: `_runToolCall` → recordToolCallSpan()
 *  - sendLLMMessageService: before/after LLM request → recordLLMSpan()
 *  - vibeContextGuardService: context size changes → recordContextSnapshot()
 *
 * Phase MVP: span buffer + OTLP JSON format + manual flush command.
 * Phase 3b: auto-flush on span count + streaming export.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { resolveOtlpUrl, buildOtlpHeaders } from './otelHttpEnvelope.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.otel.enabled': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.otel.enabled', 'Включить OTLP-экспорт трейсов для цикла работы агента VibeIDE. Без настроенного endpoint данные наружу не уходят.'),
		},
		'vibeide.otel.endpoint': {
			type: 'string',
			default: '',
			description: localize('vibeide.otel.endpoint', 'OTLP HTTP-endpoint для экспорта span-ов (например, http://localhost:4318/v1/traces). Пусто — буферизация только локально.'),
		},
		'vibeide.otel.maxBufferSpans': {
			type: 'number',
			default: 1000,
			minimum: 100,
			maximum: 10000,
			description: localize('vibeide.otel.maxBufferSpans', 'Максимум OTLP-span-ов, хранимых в памяти, перед вытеснением самых старых.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OtelSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixMs: number;
	endTimeUnixMs?: number;
	attributes: Record<string, string | number | boolean>;
	status: 'ok' | 'error' | 'unset';
	errorMessage?: string;
}

export const IVibeAgentOtelService = createDecorator<IVibeAgentOtelService>('vibeAgentOtelService');

export interface IVibeAgentOtelService {
	readonly _serviceBrand: undefined;

	/** Whether OTLP export is enabled by the user */
	isEnabled(): boolean;

	/** Start a new span; returns spanId */
	startSpan(name: string, attributes: Record<string, string | number | boolean>, parentSpanId?: string): string;

	/** End a span (sets endTimeUnixMs) */
	endSpan(spanId: string, extra?: { error?: string; additionalAttributes?: Record<string, string | number | boolean> }): void;

	/** Record a complete tool-call span (convenience) */
	recordToolCallSpan(params: {
		toolName: string;
		threadId: string;
		inputSummary: string;
		latencyMs: number;
		ok: boolean;
		error?: string;
	}): void;

	/** Record an LLM round-trip span (convenience) */
	recordLLMSpan(params: {
		model: string;
		inputTokens: number;
		outputTokens: number;
		latencyMs: number;
		ok: boolean;
		error?: string;
	}): void;

	/** Record a context size snapshot */
	recordContextSnapshot(params: {
		threadId: string;
		contextPct: number;
		budgetPct: number;
	}): void;

	/** Get all buffered spans (most recent first) */
	getSpans(): OtelSpan[];

	/** Export buffered spans as OTLP JSON string */
	exportAsOtlpJson(): string;

	/** Flush spans to configured endpoint (if any); returns number of spans flushed */
	flush(): Promise<number>;

	/** Clear span buffer */
	clear(): void;
}

// ── Implementation ─────────────────────────────────────────────────────────────

class VibeAgentOtelService extends Disposable implements IVibeAgentOtelService {
	declare readonly _serviceBrand: undefined;

	private readonly _spans: OtelSpan[] = [];
	private readonly _openSpans = new Map<string, OtelSpan>();
	private _traceId: string = this._newId(32);

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IRequestService private readonly _request: IRequestService,
	) {
		super();
	}

	isEnabled(): boolean {
		return !!this._config.getValue<boolean>('vibeide.otel.enabled');
	}

	startSpan(name: string, attributes: Record<string, string | number | boolean>, parentSpanId?: string): string {
		const spanId = this._newId(16);
		const span: OtelSpan = {
			traceId: this._traceId,
			spanId,
			parentSpanId,
			name,
			startTimeUnixMs: Date.now(),
			attributes,
			status: 'unset',
		};
		this._openSpans.set(spanId, span);
		return spanId;
	}

	endSpan(spanId: string, extra?: { error?: string; additionalAttributes?: Record<string, string | number | boolean> }): void {
		const span = this._openSpans.get(spanId);
		if (!span) { return; }
		span.endTimeUnixMs = Date.now();
		span.status = extra?.error ? 'error' : 'ok';
		if (extra?.error) { span.errorMessage = extra.error.slice(0, 500); }
		if (extra?.additionalAttributes) {
			Object.assign(span.attributes, extra.additionalAttributes);
		}
		this._openSpans.delete(spanId);
		this._pushSpan(span);
	}

	recordToolCallSpan(params: { toolName: string; threadId: string; inputSummary: string; latencyMs: number; ok: boolean; error?: string }): void {
		if (!this.isEnabled()) { return; }
		const span: OtelSpan = {
			traceId: this._traceId,
			spanId: this._newId(16),
			name: `agent.tool_call.${params.toolName}`,
			startTimeUnixMs: Date.now() - params.latencyMs,
			endTimeUnixMs: Date.now(),
			attributes: {
				'tool.name': params.toolName,
				'thread.id': params.threadId,
				'input.summary': params.inputSummary.slice(0, 200),
				'latency_ms': params.latencyMs,
			},
			status: params.ok ? 'ok' : 'error',
			errorMessage: params.error?.slice(0, 500),
		};
		this._pushSpan(span);
	}

	recordLLMSpan(params: { model: string; inputTokens: number; outputTokens: number; latencyMs: number; ok: boolean; error?: string }): void {
		if (!this.isEnabled()) { return; }
		const span: OtelSpan = {
			traceId: this._traceId,
			spanId: this._newId(16),
			name: 'agent.llm_request',
			startTimeUnixMs: Date.now() - params.latencyMs,
			endTimeUnixMs: Date.now(),
			attributes: {
				'llm.model': params.model,
				'llm.input_tokens': params.inputTokens,
				'llm.output_tokens': params.outputTokens,
				'latency_ms': params.latencyMs,
			},
			status: params.ok ? 'ok' : 'error',
			errorMessage: params.error?.slice(0, 500),
		};
		this._pushSpan(span);
	}

	recordContextSnapshot(params: { threadId: string; contextPct: number; budgetPct: number }): void {
		if (!this.isEnabled()) { return; }
		const span: OtelSpan = {
			traceId: this._traceId,
			spanId: this._newId(16),
			name: 'agent.context_snapshot',
			startTimeUnixMs: Date.now(),
			endTimeUnixMs: Date.now(),
			attributes: {
				'thread.id': params.threadId,
				'context.pct': params.contextPct,
				'budget.pct': params.budgetPct,
			},
			status: 'ok',
		};
		this._pushSpan(span);
	}

	getSpans(): OtelSpan[] {
		return [...this._spans].reverse();
	}

	exportAsOtlpJson(): string {
		// OTLP JSON format (simplified, compatible with otel-collector)
		const resourceSpans = [{
			resource: { attributes: [{ key: 'service.name', value: { stringValue: 'vibeide-agent' } }] },
			scopeSpans: [{
				scope: { name: 'vibeide.agent', version: '1.0.0' },
				spans: this._spans.map(s => ({
					traceId: s.traceId,
					spanId: s.spanId,
					parentSpanId: s.parentSpanId,
					name: s.name,
					startTimeUnixNano: String((s.startTimeUnixMs ?? 0) * 1_000_000),
					endTimeUnixNano: String((s.endTimeUnixMs ?? Date.now()) * 1_000_000),
					attributes: Object.entries(s.attributes).map(([k, v]) => ({
						key: k,
						value: typeof v === 'number' ? { intValue: String(v) } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) },
					})),
					status: { code: s.status === 'ok' ? 1 : s.status === 'error' ? 2 : 0, message: s.errorMessage ?? '' },
				})),
			}],
		}];
		return JSON.stringify({ resourceSpans }, null, 2);
	}

	async flush(): Promise<number> {
		if (!this.isEnabled()) { return 0; }
		const endpoint = this._config.getValue<string>('vibeide.otel.endpoint')?.trim();
		if (!endpoint) {
			this._log.info('[VibeAgentOtel] No endpoint configured; spans buffered locally only.');
			return 0;
		}

		const urlResult = resolveOtlpUrl({ endpoint }, 'traces');
		if (!urlResult.ok) {
			this._log.warn(`[VibeAgentOtel] Invalid endpoint: ${urlResult.reason}`);
			return 0;
		}

		const { headers } = buildOtlpHeaders({ endpoint });
		const json = this.exportAsOtlpJson();
		const count = this._spans.length;

		try {
			const ctx = await this._request.request({
				type: 'POST',
				url: urlResult.url,
				data: json,
				headers,
				callSite: 'VibeAgentOtelService.flush',
			}, CancellationToken.None);

			if (ctx.res.statusCode && ctx.res.statusCode >= 400) {
				throw new Error(`HTTP ${ctx.res.statusCode}`);
			}

			this._log.info(`[VibeAgentOtel] Flushed ${count} spans to ${urlResult.url}`);
			this._spans.length = 0;
			return count;
		} catch (err) {
			this._log.error(`[VibeAgentOtel] Flush failed: ${err}`);
			return 0;
		}
	}

	clear(): void {
		this._spans.length = 0;
		this._openSpans.clear();
		this._traceId = this._newId(32); // new trace for next session
		this._log.info('[VibeAgentOtel] Span buffer cleared');
	}

	private _pushSpan(span: OtelSpan): void {
		const maxBuffer = this._config.getValue<number>('vibeide.otel.maxBufferSpans') ?? 1000;
		this._spans.push(span);
		if (this._spans.length > maxBuffer) {
			this._spans.splice(0, this._spans.length - maxBuffer);
		}
	}

	private _newId(hexChars: number): string {
		return Array.from({ length: hexChars }, () => Math.floor(Math.random() * 16).toString(16)).join('');
	}
}

registerSingleton(IVibeAgentOtelService, VibeAgentOtelService, InstantiationType.Delayed);
