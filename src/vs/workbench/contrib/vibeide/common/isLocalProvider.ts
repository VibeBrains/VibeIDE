/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ProviderName, SettingsOfProvider } from './vibeideSettingsTypes.js';

// Detect if a provider is local (used for optimizing prompts and token budgets for local models).
// Pure predicate with no browser dependencies — lives in common/ so pure-helper tests can import
// it without pulling in browser-only modules (e.g. vs/base/browser/window via terminalToolService).
export function isLocalProvider(providerName: ProviderName, settingsOfProvider: SettingsOfProvider): boolean {
	const isExplicitLocalProvider = providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio';
	if (isExplicitLocalProvider) { return true; }

	// Check for localhost endpoints in openAICompatible or liteLLM
	if (providerName === 'openAICompatible' || providerName === 'liteLLM') {
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
	}
	return false;
}
