/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../common/vibeLog.js';
import { traceSendEvent } from '../../common/llmSendTrace.js';
import * as tls from 'tls';
import { Agent, ProxyAgent, buildConnector, setGlobalDispatcher, type Dispatcher } from 'undici';
import { SocksClient } from 'socks';

/**
 * `tls.getCACertificates` is available since Node 22.5.0 (Electron 35+ ships
 * Node 22.13+) but may be absent from the bundled `@types/node`. Narrow the
 * module to this optional shape instead of casting away the type.
 */
interface TlsWithCACertificates {
	getCACertificates?: (type?: string) => string[];
}

/**
 * Build a single shared undici Agent that trusts both the bundled Mozilla
 * CA list AND the OS trust store (Windows root store, macOS Keychain,
 * Linux ca-certificates). Required for corporate environments where a
 * proxy/AV does TLS interception with a custom root CA — Node by default
 * only trusts the Mozilla bundle and rejects with SELF_SIGNED_CERT_IN_CHAIN.
 *
 * Without this:
 *   tls.connect({ host: 'opencode.ai', ... }) → "self-signed certificate in chain"
 * With this:
 *   global fetch (used by openai/anthropic/google SDKs) trusts the corporate CA.
 *
 * The dispatcher is also returned so callers can pass it explicitly via
 * fetchOptions.dispatcher (belt & suspenders for SDKs that may bypass the
 * global dispatcher).
 */

let _dispatcher: Dispatcher | undefined;
let _initialized = false;
// Diagnostics: monotonic id + creation time of the live dispatcher. The "no tokens until restart"
// stall is suspected to be a wedged keep-alive pool; surfacing which dispatcher generation served a
// request (and how old it is) tells "reset helped" (id bumped) from "reset didn't".
let _dispatcherId = 0;
let _dispatcherCreatedAtMs = 0;
// Optional outbound proxy for ALL LLM traffic (`vibeide.llm.proxy.url`). Process-global like the
// dispatcher itself. Empty/undefined = direct connection (default). Set from the send path via
// `setLLMProxyConfig`, which rebuilds the shared pool when the value changes.
let _proxyUrl: string | undefined;

/** Snapshot of the live dispatcher generation for stall diagnostics. ageMs = how long this pool has been reused. */
export const getDispatcherDiagnostics = (): { id: number; ageMs: number; initialized: boolean; proxy: string | undefined } => ({
	id: _dispatcherId,
	ageMs: _dispatcherCreatedAtMs ? Date.now() - _dispatcherCreatedAtMs : 0,
	initialized: _initialized,
	proxy: _proxyUrl ? redactProxyUrl(_proxyUrl) : undefined,
});

/** Strip credentials from a proxy URL so it is safe to log. Falls back to a scheme-only hint. */
const redactProxyUrl = (url: string): string => {
	try {
		const u = new URL(url);
		u.username = '';
		u.password = '';
		return u.href;
	} catch {
		return url.split('://')[0] ?? '(invalid)';
	}
};

/** Collect the bundled Mozilla CA list plus the OS trust store (see the module note on corporate MITM). */
const collectCAs = (): string[] => {
	let systemCAs: string[] = [];
	try {
		// Available since Node 22.5.0 — Electron 35+ ships with Node 22.13+
		const getCACertificates = (tls as TlsWithCACertificates).getCACertificates;
		if (typeof getCACertificates === 'function') {
			systemCAs = getCACertificates('system') ?? [];
		}
	} catch (e) {
		vibeLog.warn('systemCAFetch', 'tls.getCACertificates(system) failed — system CAs unavailable:', (e as Error).message);
	}
	return [...tls.rootCertificates, ...systemCAs];
};

/**
 * Build a dispatcher that tunnels every request through a SOCKS proxy (`socks4`/`socks5`/`socks5h`).
 * undici has no native SOCKS support, so we open the SOCKS connection ourselves (via the `socks`
 * package) and hand the raw socket to undici's connector, which then performs TLS to the real target
 * over that tunnel — keeping the same system-CA trust as the direct path. Hostnames are resolved by
 * the proxy (socks5h semantics) for both `socks5` and `socks5h`, which is what a censorship-bypass
 * exit wants (avoids local DNS-based blocks); `socks4` (IPv4/host) is accepted for completeness.
 */
const buildSocksDispatcher = (proxy: URL, ca: string[]): Agent => {
	const socksType = proxy.protocol.startsWith('socks4') ? 4 : 5;
	const proxyConfig = {
		host: proxy.hostname,
		port: Number(proxy.port) || 1080,
		type: socksType as 4 | 5,
		userId: proxy.username ? decodeURIComponent(proxy.username) : undefined,
		password: proxy.password ? decodeURIComponent(proxy.password) : undefined,
	};
	const tlsConnect = buildConnector({ ca });
	const connect: buildConnector.connector = (options, callback) => {
		const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80);
		SocksClient.createConnection({
			proxy: proxyConfig,
			command: 'connect',
			destination: { host: options.hostname, port },
		}).then(({ socket }) => {
			// Let undici wrap the SOCKS tunnel with TLS to the real destination.
			tlsConnect({ ...options, httpSocket: socket }, callback);
		}).catch((err: Error) => callback(err, null));
	};
	return new Agent({ connect });
};

/** Build an HTTP/HTTPS forward-proxy dispatcher (CONNECT tunneling) trusting the system CA bundle. */
const buildHttpProxyDispatcher = (proxy: URL, ca: string[]): ProxyAgent => {
	const token = (proxy.username || proxy.password)
		? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
		: undefined;
	const clean = new URL(proxy.href);
	clean.username = '';
	clean.password = '';
	return new ProxyAgent({ uri: clean.href, token, requestTls: { ca }, proxyTls: { ca } });
};

/**
 * Build a standalone dispatcher for `proxyUrl` (empty → direct), trusting the system CA bundle.
 *
 * Exported for callers that need their own exit independent of the LLM proxy — the Telegram
 * bridge is one: `api.telegram.org` and the model APIs are blocked in different places, so
 * forcing them through one address would break whichever of the two the address does not fit.
 * `label` only names the owner in the log.
 */
export const createProxyDispatcher = (proxyUrl: string | undefined, label: string): Dispatcher => {
	const ca = collectCAs();
	if (proxyUrl) {
		try {
			const proxy = new URL(proxyUrl);
			const scheme = proxy.protocol.replace(':', '').toLowerCase();
			const agent = (scheme === 'socks' || scheme === 'socks4' || scheme === 'socks5' || scheme === 'socks5h')
				? buildSocksDispatcher(proxy, ca)
				: buildHttpProxyDispatcher(proxy, ca);
			vibeLog.info('systemCAFetch', `[dispatcher] ${label} via proxy ${redactProxyUrl(proxyUrl)} (${scheme})`);
			return agent;
		} catch (e) {
			// A bad proxy URL must not leave callers without a dispatcher — fall back to direct and warn
			// loudly. The resulting requests will hit the original geo-block, which is a visible symptom.
			vibeLog.error('systemCAFetch', `[dispatcher] ${label}: proxy "${redactProxyUrl(proxyUrl)}" unusable — falling back to direct:`, (e as Error).message);
		}
	}
	return new Agent({ connect: { ca } });
};

const buildDispatcher = (): Dispatcher => {
	const agent = createProxyDispatcher(_proxyUrl, `pool #${_dispatcherId + 1}`);
	_dispatcherId += 1;
	_dispatcherCreatedAtMs = Date.now();
	return agent;
};

/**
 * Lazily initialize a shared undici dispatcher with system CAs and install
 * it as the process-wide default. Idempotent — safe to call from every
 * LLM provider entry point.
 */
export const ensureSystemCADispatcher = (): Dispatcher => {
	if (_dispatcher) { return _dispatcher; }
	_dispatcher = buildDispatcher();
	if (!_initialized) {
		try {
			setGlobalDispatcher(_dispatcher);
			_initialized = true;
		} catch (e) {
			vibeLog.warn('systemCAFetch', 'setGlobalDispatcher failed:', (e as Error).message);
		}
	}
	traceSendEvent({ kind: 'dispatcher-create', detail: `пул #${_dispatcherId}` });
	vibeLog.info('systemCAFetch', `[dispatcher] created shared undici pool #${_dispatcherId}`);
	return _dispatcher;
};

/**
 * Force-recreate the shared dispatcher: build a fresh undici Agent, reinstall it as
 * the global dispatcher, then destroy the old one (killing any wedged keep-alive
 * sockets). Backs the «reset provider clients» diagnostic action — clears the
 * "no tokens until restart" state without restarting the IDE. Call sites that resolve
 * the dispatcher per-request (via `ensureSystemCADispatcher()`) pick up the new Agent
 * on their next call; module-level captures of the old reference would NOT, so they
 * must resolve lazily.
 */
export const resetSystemCADispatcher = (): Dispatcher => {
	const old = _dispatcher;
	_dispatcher = buildDispatcher();
	try {
		setGlobalDispatcher(_dispatcher);
		_initialized = true;
	} catch (e) {
		vibeLog.warn('systemCAFetch', 'setGlobalDispatcher (reset) failed:', (e as Error).message);
	}
	traceSendEvent({ kind: 'dispatcher-reset', detail: `пул → #${_dispatcherId}` });
	vibeLog.warn('systemCAFetch', `[dispatcher] reset shared undici pool → #${_dispatcherId} (old pool destroyed)`);
	// Tear down the old pool AFTER swapping so in-flight requests on it fail fast
	// instead of pinning sockets. Fire-and-forget — destroy() rejects in-flight requests.
	if (old) {
		void old.destroy().catch(e => vibeLog.warn('systemCAFetch', 'old dispatcher destroy failed:', (e as Error).message));
	}
	return _dispatcher;
};

/**
 * Set (or clear) the outbound proxy applied to ALL LLM traffic. Empty/whitespace clears it (direct
 * connection). Called from the send path on every request with the current `vibeide.llm.proxy.url`;
 * a no-op when unchanged, so it is cheap to call per request. When the value changes AND a pool
 * already exists, the shared dispatcher is rebuilt so the new setting takes effect without restart.
 * If no pool exists yet, the next `ensureSystemCADispatcher()` picks up the stored value.
 */
export const setLLMProxyConfig = (url: string | undefined): void => {
	const next = url && url.trim() ? url.trim() : undefined;
	if (next === _proxyUrl) { return; }
	_proxyUrl = next;
	vibeLog.info('systemCAFetch', `[proxy] LLM proxy → ${next ? redactProxyUrl(next) : 'direct'}`);
	if (_dispatcher) {
		resetSystemCADispatcher();
	}
};
