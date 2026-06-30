/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Network policy panel — outbound connection aggregator (pure helper).
 *
 * L.4 line 1045 — `VibeIDE: Show outbound connections` palette command needs to
 * display a live list of HTTP/HTTPS calls from the main process: URL without auth,
 * byte size, status, source (provider / MCP / update / telemetry). Without this
 * panel the privacy narrative ("strict-mode = no cloud") is unverifiable.
 *
 * This module owns aggregation + redaction. The runtime collector (out of scope)
 * subscribes to Electron `net.request` calls in vibeProviderProxyService and
 * mcpChannel, pushes records into an in-memory ring buffer, and renders via this
 * aggregator. The aggregator never touches storage — feed it records, get back a
 * grouped, redacted view.
 *
 * Adoption order:
 *   1. Add an interceptor in the provider proxy + MCP channel + updater that
 *      captures `OutboundRecord` per request.
 *   2. Store the last N=100 records in a ring buffer (in-memory only; privacy by
 *      default).
 *   3. Palette command `vibeide.network.showOutbound` passes the buffer to
 *      `aggregateOutboundConnections(records, options?)` and renders the result.
 *   4. `vibe doctor --network` reuses the same aggregator for its summary.
 */

export type OutboundSource =
	| 'provider'
	| 'mcp'
	| 'update'
	| 'telemetry'
	| 'models-registry'
	| 'unknown';

export interface OutboundRecord {
	readonly timestampMs: number;
	readonly url: string;
	readonly method: string;
	readonly statusCode?: number;
	readonly bytesIn?: number;
	readonly bytesOut?: number;
	readonly source: OutboundSource;
	/** Optional context — provider id, MCP server name, etc. NEVER tokens or auth. */
	readonly context?: string;
}

export interface RedactedOutboundRecord extends OutboundRecord {
	/** URL with auth credentials, query-string secrets, and userinfo stripped. */
	readonly url: string;
	readonly host: string;
	/** True if the original URL contained anything that looked like auth. */
	readonly redacted: boolean;
}

export interface OutboundGroup {
	readonly host: string;
	readonly source: OutboundSource;
	readonly count: number;
	readonly totalBytesIn: number;
	readonly totalBytesOut: number;
	readonly statusCodeHistogram: Readonly<Record<number, number>>;
	readonly firstAtMs: number;
	readonly lastAtMs: number;
	readonly contexts: readonly string[];
}

export interface OutboundAggregate {
	readonly windowMs: number;
	readonly totalRecords: number;
	readonly groups: readonly OutboundGroup[];
	readonly perSource: Readonly<Record<OutboundSource, number>>;
}

export interface AggregateOptions {
	/** Time window relative to `now` (ms). Records older than this are dropped. Default 5 min. */
	readonly windowMs?: number;
	readonly now?: number;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1_000;

/**
 * Pure: redacts a URL — strips userinfo (`user:pass@host`) and query-string keys
 * that look like auth (`token`, `apikey`, `access_token`, etc). Returns null on
 * malformed input so the caller can drop the record entirely.
 */
export function redactOutboundUrl(rawUrl: string): { redactedUrl: string; host: string; wasRedacted: boolean } | null {
	if (typeof rawUrl !== 'string' || rawUrl.length === 0) { return null; }
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return null;
	}
	let wasRedacted = false;
	if (parsed.username || parsed.password) {
		parsed.username = '';
		parsed.password = '';
		wasRedacted = true;
	}
	const sensitiveKeys = ['token', 'apikey', 'api_key', 'access_token', 'refresh_token', 'auth', 'authorization', 'key', 'secret'];
	let touchedQs = false;
	for (const key of Array.from(parsed.searchParams.keys())) {
		if (sensitiveKeys.includes(key.toLowerCase())) {
			parsed.searchParams.set(key, '[REDACTED]');
			touchedQs = true;
		}
	}
	if (touchedQs) { wasRedacted = true; }
	return { redactedUrl: parsed.toString(), host: parsed.host, wasRedacted };
}

/**
 * Pure: redacts an OutboundRecord into a sanitised RedactedOutboundRecord.
 * Returns null on malformed URL (caller drops).
 */
export function redactOutboundRecord(record: OutboundRecord): RedactedOutboundRecord | null {
	const r = redactOutboundUrl(record.url);
	if (!r) { return null; }
	return { ...record, url: r.redactedUrl, host: r.host, redacted: r.wasRedacted };
}

/**
 * Pure: aggregates outbound records over a time window into groups by (host, source).
 * Drops records with malformed URL silently. Order: groups sorted by `count` desc,
 * then by `host` asc for stability.
 */
export function aggregateOutboundConnections(
	records: readonly OutboundRecord[],
	options: AggregateOptions = {},
): OutboundAggregate {
	const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
	const now = options.now ?? Date.now();
	const cutoff = now - windowMs;

	const buckets = new Map<string, { host: string; source: OutboundSource; entries: RedactedOutboundRecord[] }>();
	const perSource: Record<OutboundSource, number> = {
		provider: 0, mcp: 0, update: 0, telemetry: 0, 'models-registry': 0, unknown: 0,
	};
	let totalRecords = 0;

	for (const r of records) {
		if (r.timestampMs < cutoff) { continue; }
		const sane = redactOutboundRecord(r);
		if (!sane) { continue; }
		totalRecords++;
		perSource[sane.source]++;
		const key = `${sane.host}|${sane.source}`;
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { host: sane.host, source: sane.source, entries: [] };
			buckets.set(key, bucket);
		}
		bucket.entries.push(sane);
	}

	const groups: OutboundGroup[] = [];
	for (const b of buckets.values()) {
		const histogram: Record<number, number> = {};
		let totalBytesIn = 0;
		let totalBytesOut = 0;
		let firstAtMs = Infinity;
		let lastAtMs = -Infinity;
		const contextSet = new Set<string>();
		for (const e of b.entries) {
			if (typeof e.statusCode === 'number') {
				histogram[e.statusCode] = (histogram[e.statusCode] ?? 0) + 1;
			}
			if (typeof e.bytesIn === 'number') { totalBytesIn += e.bytesIn; }
			if (typeof e.bytesOut === 'number') { totalBytesOut += e.bytesOut; }
			if (e.timestampMs < firstAtMs) { firstAtMs = e.timestampMs; }
			if (e.timestampMs > lastAtMs) { lastAtMs = e.timestampMs; }
			if (e.context) { contextSet.add(e.context); }
		}
		groups.push({
			host: b.host,
			source: b.source,
			count: b.entries.length,
			totalBytesIn,
			totalBytesOut,
			statusCodeHistogram: histogram,
			firstAtMs: firstAtMs === Infinity ? 0 : firstAtMs,
			lastAtMs: lastAtMs === -Infinity ? 0 : lastAtMs,
			contexts: Array.from(contextSet).sort(),
		});
	}
	groups.sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
	return { windowMs, totalRecords, groups, perSource };
}

/**
 * Pure: renders the aggregate as a markdown table for the palette / vibe doctor
 * --network output. Stable column order; status codes joined as `200×N, 4xx×M`.
 */
export function renderOutboundConnectionsMarkdown(aggregate: OutboundAggregate): string {
	const lines: string[] = [];
	lines.push(`## Outbound connections — last ${formatWindowMs(aggregate.windowMs)}`);
	lines.push(``);
	lines.push(`Total records: **${aggregate.totalRecords}**`);
	lines.push(``);
	const sources = (Object.keys(aggregate.perSource) as OutboundSource[])
		.filter(s => aggregate.perSource[s] > 0)
		.sort();
	if (sources.length > 0) {
		lines.push(`By source: ${sources.map(s => `${s}=${aggregate.perSource[s]}`).join(', ')}`);
		lines.push(``);
	}
	if (aggregate.groups.length === 0) {
		lines.push('_(no outbound connections recorded in the window)_');
		return lines.join('\n');
	}
	lines.push(`| Host | Source | Count | Bytes in | Bytes out | Status |`);
	lines.push(`| --- | --- | ---: | ---: | ---: | --- |`);
	for (const g of aggregate.groups) {
		const status = formatStatusHistogram(g.statusCodeHistogram);
		lines.push(`| ${g.host} | ${g.source} | ${g.count} | ${g.totalBytesIn} | ${g.totalBytesOut} | ${status} |`);
	}
	return lines.join('\n');
}

function formatWindowMs(ms: number): string {
	if (ms < 60_000) { return `${Math.round(ms / 1_000)}s`; }
	if (ms < 3_600_000) { return `${Math.round(ms / 60_000)}m`; }
	return `${Math.round(ms / 3_600_000)}h`;
}

function formatStatusHistogram(h: Readonly<Record<number, number>>): string {
	const codes = Object.keys(h).map(Number).sort((a, b) => a - b);
	if (codes.length === 0) { return '—'; }
	return codes.map(c => `${c}×${h[c]}`).join(', ');
}
