/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeProviderProxyService — optional local HTTP(S) debug proxy for AI providers.
 *
 * When enabled, provider requests are routed through a local proxy that
 * captures raw request/response payloads for in-IDE inspection (Charles/mitmproxy–like UX).
 *
 * Privacy guarantees:
 *  - Disabled by default (vibeide.debug.providerProxy.enabled = false)
 *  - Secret values in headers are ALWAYS redacted before display (secret detection pipeline)
 *  - No data leaves the local machine via this service
 *  - Stealth mode: proxy is force-disabled when stealth mode is active
 *
 * Phase MVP: registry + command palette entry (Open Provider Proxy Log)
 * Phase 3b: actual HTTP interception via Electron net module or node:http proxy
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { IVibeOutboundRingBuffer } from '../common/vibeOutboundRingBuffer.js';
import { evaluateOutbound, buildDefaultAllowlist } from '../common/outboundAllowlist.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ISecretDetectionService } from '../common/secretDetectionService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.debug.providerProxy.enabled': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.debug.providerProxy.enabled', 'Локальный debug-прокси для сырых запросов/ответов AI-провайдера. ⚠️ Перехват запросов пока НЕ подключён к send-пути (HTTP идёт в main-процессе) — лог останется пустым. Для захвата ПОЛНОГО LLM-запроса используйте настройку `vibeide.debug.dumpFullPrompt` — она пишет system + по каждому сообщению content/reasoning/tool в лог `[VibeIDE/promptDump]` (секреты редактируются).'),
			scope: 1, // APPLICATION
		},
		'vibeide.debug.providerProxy.maxEntries': {
			type: 'number',
			default: 50,
			minimum: 10,
			maximum: 500,
			description: localize('vibeide.debug.providerProxy.maxEntries', 'Максимальное число захваченных прокси-записей, хранимых в памяти.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProxyEntry {
	id: string;
	ts: number;
	provider: string;
	method: string;
	url: string;
	/** Request headers with secrets redacted */
	requestHeaders: Record<string, string>;
	/** Request body with secrets redacted (JSON or truncated string) */
	requestBody: string;
	/** Response status */
	responseStatus?: number;
	/** Response headers */
	responseHeaders?: Record<string, string>;
	/** Response body with secrets redacted */
	responseBody?: string;
	/** Latency in ms */
	latencyMs?: number;
	/** True if secrets were detected and redacted */
	wasRedacted: boolean;
}

export const IVibeProviderProxyService = createDecorator<IVibeProviderProxyService>('vibeProviderProxyService');

export interface IVibeProviderProxyService {
	readonly _serviceBrand: undefined;

	/** Whether the proxy is currently enabled */
	isEnabled(): boolean;

	/** Record a provider request (called by sendLLMMessageService when proxy is enabled) */
	recordRequest(provider: string, method: string, url: string, headers: Record<string, string>, body: string): string;

	/** Record the response for a previously recorded request */
	recordResponse(entryId: string, status: number, headers: Record<string, string>, body: string): void;

	/** Get all captured entries (most recent first) */
	getEntries(): ProxyEntry[];

	/** Clear all captured entries */
	clear(): void;

	/** Fired when a new entry is added or updated */
	readonly onEntryAdded: Event<ProxyEntry>;
}

// ── Implementation ─────────────────────────────────────────────────────────────

class VibeProviderProxyService extends Disposable implements IVibeProviderProxyService {
	declare readonly _serviceBrand: undefined;

	private _entries: ProxyEntry[] = [];
	private readonly _onEntryAdded = this._register(new Emitter<ProxyEntry>());
	readonly onEntryAdded: Event<ProxyEntry> = this._onEntryAdded.event;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@ISecretDetectionService private readonly _secretDetection: ISecretDetectionService,
		@IVibeOutboundRingBuffer private readonly _outboundBuffer: IVibeOutboundRingBuffer,
	) {
		super();
	}

	isEnabled(): boolean {
		return !!this._config.getValue<boolean>('vibeide.debug.providerProxy.enabled');
	}

	recordRequest(provider: string, method: string, url: string, headers: Record<string, string>, body: string): string {
		if (!this.isEnabled()) { return ''; }

		// Privacy strict-mode gate (L1044): warn when an outbound URL would be blocked.
		const privacyStrict = !!this._config.getValue<boolean>('vibeide.privacy.strict');
		if (privacyStrict) {
			const allowlist = buildDefaultAllowlist();
			const decision = evaluateOutbound({ url, privacyStrict, allowlist });
			if (decision.kind === 'block') {
				this._log.warn(`[VibeProviderProxy] strict-mode: blocking ${url} (${decision.reason})`);
			}
		}

		const id = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const redactedHeaders = this._redactHeaders(headers);
		const { redactedText, hasSecrets: bodyRedacted } = this._secretDetection.detectSecrets(body);
		const headersRedacted = JSON.stringify(redactedHeaders) !== JSON.stringify(headers);

		const entry: ProxyEntry = {
			id,
			ts: Date.now(),
			provider,
			method,
			url,
			requestHeaders: redactedHeaders,
			requestBody: redactedText.slice(0, 8192), // cap at 8KB for display
			wasRedacted: bodyRedacted || headersRedacted,
		};

		this._pushEntry(entry);
		// Privacy panel collector hookup (roadmap §1042) — push redacted record into
		// the in-memory ring buffer so `vibeide.network.showOutbound` and
		// `vibe doctor --network` can render it without persisting to disk.
		this._outboundBuffer.record({
			timestampMs: entry.ts,
			url,
			method,
			source: 'provider',
			context: provider,
			bytesOut: body.length,
		});
		this._log.info(`[VibeProviderProxy] Captured request ${id}: ${method} ${url}`);
		return id;
	}

	recordResponse(entryId: string, status: number, headers: Record<string, string>, body: string): void {
		if (!this.isEnabled()) { return; }

		const entry = this._entries.find(e => e.id === entryId);
		if (!entry) { return; }

		const { redactedText, hasSecrets } = this._secretDetection.detectSecrets(body);
		entry.responseStatus = status;
		entry.responseHeaders = this._redactHeaders(headers);
		entry.responseBody = redactedText.slice(0, 8192);
		entry.latencyMs = Date.now() - entry.ts;
		if (hasSecrets) { entry.wasRedacted = true; }

		this._onEntryAdded.fire(entry);
	}

	getEntries(): ProxyEntry[] {
		return [...this._entries].reverse(); // most recent first
	}

	clear(): void {
		this._entries = [];
		this._log.info('[VibeProviderProxy] Log cleared');
	}

	private _pushEntry(entry: ProxyEntry): void {
		const maxEntries = this._config.getValue<number>('vibeide.debug.providerProxy.maxEntries') ?? 50;
		this._entries.push(entry);
		if (this._entries.length > maxEntries) {
			this._entries.splice(0, this._entries.length - maxEntries);
		}
		this._onEntryAdded.fire(entry);
	}

	private _redactHeaders(headers: Record<string, string>): Record<string, string> {
		return redactAuthHeaders(headers);
	}
}

/**
 * Positive list of HTTP header names to redact in the provider proxy log. Match is
 * case-insensitive (per RFC 7230 § 3.2 — header field names are case-insensitive).
 *
 * This list runs BEFORE the body's `ISecretDetectionService` pass, so that a token
 * like `Authorization: Bearer eyJ…` does not need to match a body secret pattern to
 * be removed. Add a new header here only with the same review process as
 * `references/v1/a2ui-allowed-commands.md` — every entry is a security decision.
 */
export const PROXY_REDACT_HEADER_NAMES: readonly string[] = Object.freeze([
	'authorization',
	'proxy-authorization',
	'x-api-key',
	'api-key',
	'apikey',
	'x-goog-api-key',
	'x-openai-api-key',
	'anthropic-api-key',
	'x-anthropic-api-key',
	'x-amzn-bearer-token',
	'x-aws-access-token',
	'cookie',
	'set-cookie',
]);

/**
 * Pure helper. Returns a copy of `headers` with every entry whose name (case-insensitive)
 * matches `PROXY_REDACT_HEADER_NAMES` replaced with `'[REDACTED]'`. Original header
 * casing is preserved on output. Non-string values are coerced to a placeholder so the
 * helper never propagates raw objects into the log.
 */
export function redactAuthHeaders(headers: Record<string, string>): Record<string, string> {
	const sensitive = new Set(PROXY_REDACT_HEADER_NAMES.map(s => s.toLowerCase()));
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		if (sensitive.has(k.toLowerCase())) {
			out[k] = '[REDACTED]';
			continue;
		}
		out[k] = typeof v === 'string' ? v : '[non-string-value]';
	}
	return out;
}

registerSingleton(IVibeProviderProxyService, VibeProviderProxyService, InstantiationType.Delayed);

// ── Commands ──────────────────────────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.debug.openProviderProxyLog',
			title: { value: localize('vibeide.debug.openProviderProxyLog', 'Debug: Открыть лог прокси провайдера'), original: 'Debug: Open Provider Proxy Log' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const proxy = accessor.get(IVibeProviderProxyService);
		if (!proxy.isEnabled()) {
			// Prompt user to enable via setting
			accessor.get(INotificationService).info(
				localize('vibeide.debug.proxyDisabled', 'Захват прокси провайдера отключён (и ещё не подключён к пути отправки). Чтобы захватить полный LLM-запрос, включите настройку «vibeide.debug.dumpFullPrompt» и воспроизведите — лог пишется в канал [VibeIDE/promptDump].')
			);
			return;
		}
		const entries = proxy.getEntries();
		const content = entries.length === 0
			? '// Provider-proxy request capture is not wired yet (the LLM request is made in the main process, this proxy lives in the renderer).\n// To capture the full request, enable setting `vibeide.debug.dumpFullPrompt` and reproduce — it dumps system + per-message content/reasoning/tool into the [VibeIDE/promptDump] log (secrets redacted).'
			: JSON.stringify(entries, null, 2);

		// Resolve services synchronously before the first await — the accessor is only valid
		// during the synchronous portion of the action handler.
		const modelService = accessor.get(ITextModelService);
		const editorService = accessor.get(IEditorService);
		const uri = URI.parse(`untitled://provider-proxy-log-${Date.now()}.json`);
		const ref = await modelService.createModelReference(uri);
		ref.object.textEditorModel?.setValue(content);
		ref.dispose();
		await editorService.openEditor({ resource: uri });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.debug.clearProviderProxyLog',
			title: { value: localize('vibeide.debug.clearProviderProxyLog', 'Debug: Очистить лог прокси провайдера'), original: 'Debug: Clear Provider Proxy Log' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IVibeProviderProxyService).clear();
	}
});
