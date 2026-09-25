/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ProviderId, SettingsOfProvider } from './vibeideSettingsTypes.js';

/** Hosts that name this machine; the shared set lists the same four (`testVectors/providerAuth.json`) */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * The address points at this machine
 * An IPv6 host comes back from `URL` in brackets (`[::1]`), so a bare `::1` never matched it
 * `0.0.0.0` counts: servers print it as their listen address, and a request to it reaches this machine
 */
export function isLocalAddress(address: string | undefined): boolean {
	if (!address) { return false; }
	try {
		const hostname = new URL(address).hostname.replace(/^\[(.*)\]$/, '$1');
		return LOCAL_HOSTS.has(hostname);
	} catch {
		return false;
	}
}

// Detect if a provider is local (used for optimizing prompts and token budgets for local models).
// Pure predicate with no browser dependencies — lives in common/ so pure-helper tests can import
// it without pulling in browser-only modules (e.g. vs/base/browser/window via terminalToolService).
export function isLocalProvider(providerName: ProviderId, settingsOfProvider: SettingsOfProvider): boolean {
	const isExplicitLocalProvider = providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio';
	if (isExplicitLocalProvider) { return true; }

	// Localhost endpoint = local, whoever owns the id — a built-in with an endpoint field
	// (openAICompatible / liteLLM / lmRoute) or a CONFIG provider (providers.json), whose seed
	// carries its baseURL as `endpoint`. Restricting this to two hardcoded built-ins made
	// config providers pointed at localhost miss every local-model optimization.
	return isLocalAddress(settingsOfProvider[providerName]?.endpoint);
}
