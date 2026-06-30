/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Outbound URL allowlist policy (1047) — pure decision.
 *
 * `vibeide.privacy.strict = true` blocks every outbound HTTP/HTTPS call
 * that isn't explicitly allowed. This module evaluates whether a given
 * URL passes the allowlist. It does NOT make the request — `VibeProviderProxyService`
 * (or the Electron net wrapper) calls `evaluateOutbound()` first and
 * surfaces a toast on block.
 *
 * Allowlist entry forms (parsed from settings):
 *   - exact host: `api.anthropic.com`
 *   - host wildcard: `*.anthropic.com`
 *   - localhost-with-port: `localhost:11434`
 *   - URL prefix: `https://github.com/borodatych/`
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface OutboundAllowlistEntry {
	pattern: string;
	/** Required for wildcard / port-pinned matches. Optional for prefix matches. */
	kind: 'host' | 'host-wildcard' | 'localhost-port' | 'prefix';
	/** Human-readable note shown in the audit log on a hit. */
	note?: string;
}

export interface OutboundAllowlistInput {
	url: string;
	privacyStrict: boolean;
	allowlist: ReadonlyArray<OutboundAllowlistEntry>;
}

export type OutboundDecision =
	| { kind: 'allow'; matchedEntry?: OutboundAllowlistEntry; reason: 'always-allow' | 'allowlist-match' }
	| { kind: 'block'; reason: 'no-allowlist-match' | 'malformed-url' | 'non-http-scheme' };

const HTTP_SCHEMES = new Set(['http:', 'https:']);

/**
 * Evaluate one outbound request. Pure.
 *
 * - When `privacyStrict = false`: every URL is allowed (this module exists
 *   only for the strict-mode gate; no-strict callers don't need to ask).
 * - When `privacyStrict = true`: every URL must match at least one
 *   allowlist entry. No match → block. Malformed URL → block. Non-http
 *   scheme → block.
 */
export function evaluateOutbound(input: OutboundAllowlistInput): OutboundDecision {
	if (!input.privacyStrict) {
		return { kind: 'allow', reason: 'always-allow' };
	}

	let parsed: URL;
	try {
		parsed = new URL(input.url);
	} catch {
		return { kind: 'block', reason: 'malformed-url' };
	}

	if (!HTTP_SCHEMES.has(parsed.protocol)) {
		return { kind: 'block', reason: 'non-http-scheme' };
	}

	for (const entry of input.allowlist) {
		if (matchesEntry(parsed, entry)) {
			return { kind: 'allow', matchedEntry: entry, reason: 'allowlist-match' };
		}
	}
	return { kind: 'block', reason: 'no-allowlist-match' };
}

function matchesEntry(url: URL, entry: OutboundAllowlistEntry): boolean {
	switch (entry.kind) {
		case 'host':
			return url.hostname.toLowerCase() === entry.pattern.toLowerCase();
		case 'host-wildcard': {
			// `*.anthropic.com` — match `api.anthropic.com`, `cdn.anthropic.com`,
			// but NOT bare `anthropic.com` (lower bound is at least one segment).
			const base = entry.pattern.toLowerCase().replace(/^\*\./, '');
			const host = url.hostname.toLowerCase();
			return host !== base && host.endsWith('.' + base);
		}
		case 'localhost-port': {
			// `localhost:11434` — must match host AND port.
			const [host, port] = entry.pattern.split(':');
			if (!host || !port) { return false; }
			return url.hostname === host && url.port === port;
		}
		case 'prefix':
			return url.toString().startsWith(entry.pattern);
	}
}

/**
 * Build the canonical default allowlist for VibeIDE strict mode. Pure.
 *
 * Three buckets:
 *   - Local model providers (Ollama, lmstudio defaults).
 *   - GitHub Release manifest endpoint (auto-update needs to fetch).
 *   - Registered MCP servers — caller passes in the parsed mcp.json
 *     server URLs and they get added as exact-host or prefix entries.
 *
 * The runtime composes this default + the user's `vibeide.privacy.allowlist`
 * extras and feeds the union into `evaluateOutbound`.
 */
export function buildDefaultAllowlist(
	mcpServerUrls: ReadonlyArray<string> = [],
): OutboundAllowlistEntry[] {
	const entries: OutboundAllowlistEntry[] = [
		{ pattern: 'localhost:11434', kind: 'localhost-port', note: 'Ollama default' },
		{ pattern: 'localhost:1234', kind: 'localhost-port', note: 'lmstudio default' },
		{ pattern: '127.0.0.1:11434', kind: 'localhost-port', note: 'Ollama loopback' },
		{ pattern: 'https://api.github.com/repos/', kind: 'prefix', note: 'GitHub release manifest' },
		{ pattern: 'https://github.com/', kind: 'prefix', note: 'GitHub web UI redirects (release assets)' },
	];

	for (const raw of mcpServerUrls) {
		try {
			const url = new URL(raw);
			entries.push({
				pattern: url.hostname,
				kind: 'host',
				note: `MCP server (${url.hostname})`,
			});
		} catch {
			// Skip malformed URLs silently — caller already validated the mcp.json shape.
		}
	}

	return entries;
}
