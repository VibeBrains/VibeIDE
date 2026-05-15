/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------*/

import * as tls from 'node:tls'
import { Agent, setGlobalDispatcher } from 'undici'

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

let _dispatcher: Agent | undefined
let _initialized = false

const buildDispatcher = (): Agent => {
	let systemCAs: string[] = []
	try {
		// Available since Node 22.5.0 — Electron 35+ ships with Node 22.13+
		if (typeof (tls as any).getCACertificates === 'function') {
			systemCAs = (tls as any).getCACertificates('system') ?? []
		}
	} catch (e) {
		console.warn('[VibeIDE] tls.getCACertificates(system) failed — system CAs unavailable:', (e as Error).message)
	}
	const ca = [...tls.rootCertificates, ...systemCAs]
	const agent = new Agent({ connect: { ca } })
	return agent
}

/**
 * Lazily initialize a shared undici dispatcher with system CAs and install
 * it as the process-wide default. Idempotent — safe to call from every
 * LLM provider entry point.
 */
export const ensureSystemCADispatcher = (): Agent => {
	if (_dispatcher) return _dispatcher
	_dispatcher = buildDispatcher()
	if (!_initialized) {
		try {
			setGlobalDispatcher(_dispatcher)
			_initialized = true
		} catch (e) {
			console.warn('[VibeIDE] setGlobalDispatcher failed:', (e as Error).message)
		}
	}
	return _dispatcher
}
