/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `VibeAgentOtelService` — OTLP/HTTP/JSON envelope builder (pure helper)
 * (roadmap §"Real-impl tail / Phase 3b — `VibeAgentOtelService` Electron net
 * OTLP HTTP export (без него `vibe run --otel-endpoint` не работает)").
 *
 * OTLP/HTTP/JSON spec: https://opentelemetry.io/docs/specs/otlp/#otlphttp
 *
 * Pure helpers — `vscode`-free. Caller owns the HTTP fetch via Electron net
 * or Node `https`; this module produces the JSON body, headers, and
 * endpoint URL that the runtime POSTs.
 */

const OTLP_TRACES_PATH = '/v1/traces';
const OTLP_METRICS_PATH = '/v1/metrics';
const OTLP_LOGS_PATH = '/v1/logs';

export type OtlpSignal = 'traces' | 'metrics' | 'logs';

export interface OtlpEndpointConfig {
	readonly endpoint: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly compression?: 'none' | 'gzip';
}

export type ResolveOtlpUrlResult =
	| { readonly ok: true; readonly url: string }
	| { readonly ok: false; readonly reason: 'endpoint-empty' | 'endpoint-malformed' | 'endpoint-not-http(s)' };

/**
 * Resolve the per-signal POST URL. The OTLP spec allows either a base
 * endpoint (helper appends `/v1/<signal>`) or a fully-qualified per-signal
 * URL (helper trusts caller, uses verbatim).
 *
 * Signal detection: if `endpoint` already ends with `/v1/<signal>` for the
 * requested signal, use as-is; otherwise treat as base and append.
 *
 * Refuses non-http(s) schemes; collectors over `unix://` etc are not
 * supported by this skeleton.
 */
export function resolveOtlpUrl(config: OtlpEndpointConfig, signal: OtlpSignal): ResolveOtlpUrlResult {
	if (typeof config.endpoint !== 'string' || config.endpoint.trim().length === 0) {
		return { ok: false, reason: 'endpoint-empty' };
	}
	let parsed: URL;
	try {
		parsed = new URL(config.endpoint.trim());
	} catch {
		return { ok: false, reason: 'endpoint-malformed' };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { ok: false, reason: 'endpoint-not-http(s)' };
	}
	const expected = signalPath(signal);
	if (parsed.pathname.endsWith(expected)) {
		return { ok: true, url: parsed.toString() };
	}
	const base = parsed.pathname.replace(/\/$/, '');
	const out = new URL(base + expected, parsed);
	out.search = parsed.search;
	out.hash = parsed.hash;
	return { ok: true, url: out.toString() };
}

function signalPath(signal: OtlpSignal): string {
	switch (signal) {
		case 'traces': return OTLP_TRACES_PATH;
		case 'metrics': return OTLP_METRICS_PATH;
		case 'logs': return OTLP_LOGS_PATH;
	}
}

export interface OtlpHttpHeaders {
	readonly headers: Readonly<Record<string, string>>;
	readonly contentType: 'application/json';
}

/**
 * Build the HTTP headers for an OTLP/HTTP/JSON request. Always
 * `Content-Type: application/json`; merges user-supplied headers (Bearer
 * tokens, tenant ids); refuses `content-type` overrides to prevent the
 * caller accidentally breaking OTLP wire format.
 */
export function buildOtlpHeaders(config: OtlpEndpointConfig): OtlpHttpHeaders {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (config.headers !== undefined) {
		for (const [k, v] of Object.entries(config.headers)) {
			if (typeof k !== 'string' || typeof v !== 'string') { continue; }
			if (k.toLowerCase() === 'content-type') { continue; }
			headers[k] = v;
		}
	}
	if (config.compression === 'gzip') {
		headers['Content-Encoding'] = 'gzip';
	}
	return { headers, contentType: 'application/json' };
}

// -----------------------------------------------------------------------------
// Resource + Span shapes (OTLP §5.1)
// -----------------------------------------------------------------------------

export type AttributeValue = string | number | boolean;

export interface OtlpAttribute {
	readonly key: string;
	readonly value: AttributeValue;
}

export interface OtlpSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly kind: 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';
	readonly startTimeUnixNano: string;
	readonly endTimeUnixNano: string;
	readonly attributes?: ReadonlyArray<OtlpAttribute>;
	readonly status?: { readonly code: 'STATUS_CODE_UNSET' | 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR'; readonly message?: string };
}

export interface OtlpResource {
	readonly attributes: ReadonlyArray<OtlpAttribute>;
}

const HEX_TRACE_ID = /^[a-f0-9]{32}$/;
const HEX_SPAN_ID = /^[a-f0-9]{16}$/;

/**
 * Build the JSON body for `POST /v1/traces`. OTLP/HTTP/JSON spec §7.
 * Refuses malformed trace/span ids (must be lowercase-hex; 32/16 chars).
 */
export function buildOtlpTracesBody(input: {
	readonly resource: OtlpResource;
	readonly spans: ReadonlyArray<OtlpSpan>;
	readonly scopeName: string;
	readonly scopeVersion?: string;
}): { readonly ok: true; readonly body: string } | { readonly ok: false; readonly reason: string } {
	if (typeof input.scopeName !== 'string' || input.scopeName.length === 0) {
		return { ok: false, reason: 'scope-name-empty' };
	}
	for (let i = 0; i < input.spans.length; i++) {
		const s = input.spans[i];
		if (!HEX_TRACE_ID.test(s.traceId)) { return { ok: false, reason: `spans[${i}]:traceId-malformed` }; }
		if (!HEX_SPAN_ID.test(s.spanId)) { return { ok: false, reason: `spans[${i}]:spanId-malformed` }; }
		if (s.parentSpanId !== undefined && !HEX_SPAN_ID.test(s.parentSpanId)) {
			return { ok: false, reason: `spans[${i}]:parentSpanId-malformed` };
		}
		if (typeof s.name !== 'string' || s.name.length === 0) { return { ok: false, reason: `spans[${i}]:name-empty` }; }
		if (!isUnixNano(s.startTimeUnixNano)) { return { ok: false, reason: `spans[${i}]:startTime-malformed` }; }
		if (!isUnixNano(s.endTimeUnixNano)) { return { ok: false, reason: `spans[${i}]:endTime-malformed` }; }
	}
	const payload = {
		resourceSpans: [{
			resource: { attributes: input.resource.attributes.map(toJsonAttribute) },
			scopeSpans: [{
				scope: {
					name: input.scopeName,
					...(input.scopeVersion !== undefined ? { version: input.scopeVersion } : {}),
				},
				spans: input.spans.map(toJsonSpan),
			}],
		}],
	};
	return { ok: true, body: JSON.stringify(payload) };
}

function isUnixNano(s: string): boolean {
	return typeof s === 'string' && /^\d{1,21}$/.test(s);
}

function toJsonAttribute(a: OtlpAttribute): { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } } {
	if (typeof a.value === 'string') { return { key: a.key, value: { stringValue: a.value } }; }
	if (typeof a.value === 'boolean') { return { key: a.key, value: { boolValue: a.value } }; }
	if (Number.isInteger(a.value)) { return { key: a.key, value: { intValue: String(a.value) } }; }
	return { key: a.key, value: { doubleValue: a.value } };
}

function toJsonSpan(s: OtlpSpan): Record<string, unknown> {
	const out: Record<string, unknown> = {
		traceId: s.traceId,
		spanId: s.spanId,
		name: s.name,
		kind: s.kind,
		startTimeUnixNano: s.startTimeUnixNano,
		endTimeUnixNano: s.endTimeUnixNano,
	};
	if (s.parentSpanId !== undefined) { out.parentSpanId = s.parentSpanId; }
	if (s.attributes !== undefined && s.attributes.length > 0) {
		out.attributes = s.attributes.map(toJsonAttribute);
	}
	if (s.status !== undefined) {
		out.status = s.status.message !== undefined
			? { code: s.status.code, message: s.status.message }
			: { code: s.status.code };
	}
	return out;
}
