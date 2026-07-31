/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ProviderId, SettingsOfProvider } from './vibeideSettingsTypes.js';

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
	const endpoint = settingsOfProvider[providerName]?.endpoint || '';
	if (endpoint) {
		try {
			const url = new URL(endpoint);
			const hostname = url.hostname.toLowerCase();
			return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
		} catch (e) {
			return false;
		}
	}
	return false;
}
