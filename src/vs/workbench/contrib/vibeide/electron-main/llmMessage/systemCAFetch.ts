/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../common/vibeLog.js';
import * as tls from 'tls';
import { Agent, setGlobalDispatcher } from 'undici';

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

let _dispatcher: Agent | undefined;
let _initialized = false;
// Diagnostics: monotonic id + creation time of the live dispatcher. The "no tokens until restart"
// stall is suspected to be a wedged keep-alive pool; surfacing which dispatcher generation served a
// request (and how old it is) tells "reset helped" (id bumped) from "reset didn't".
let _dispatcherId = 0;
let _dispatcherCreatedAtMs = 0;

/** Snapshot of the live dispatcher generation for stall diagnostics. ageMs = how long this pool has been reused. */
export const getDispatcherDiagnostics = (): { id: number; ageMs: number; initialized: boolean } => ({
	id: _dispatcherId,
	ageMs: _dispatcherCreatedAtMs ? Date.now() - _dispatcherCreatedAtMs : 0,
	initialized: _initialized,
});

const buildDispatcher = (): Agent => {
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
	const ca = [...tls.rootCertificates, ...systemCAs];
	const agent = new Agent({ connect: { ca } });
	_dispatcherId += 1;
	_dispatcherCreatedAtMs = Date.now();
	return agent;
};

/**
 * Lazily initialize a shared undici dispatcher with system CAs and install
 * it as the process-wide default. Idempotent — safe to call from every
 * LLM provider entry point.
 */
export const ensureSystemCADispatcher = (): Agent => {
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
export const resetSystemCADispatcher = (): Agent => {
	const old = _dispatcher;
	_dispatcher = buildDispatcher();
	try {
		setGlobalDispatcher(_dispatcher);
		_initialized = true;
	} catch (e) {
		vibeLog.warn('systemCAFetch', 'setGlobalDispatcher (reset) failed:', (e as Error).message);
	}
	vibeLog.warn('systemCAFetch', `[dispatcher] reset shared undici pool → #${_dispatcherId} (old pool destroyed)`);
	// Tear down the old pool AFTER swapping so in-flight requests on it fail fast
	// instead of pinning sockets. Fire-and-forget — destroy() rejects in-flight requests.
	if (old) {
		void old.destroy().catch(e => vibeLog.warn('systemCAFetch', 'old dispatcher destroy failed:', (e as Error).message));
	}
	return _dispatcher;
};
