/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which configured providers get a card in the "Модели" settings section.
 *
 * Cloud providers hide themselves naturally: without an API key they are not configured, so they
 * never reach this list. Local ones (Ollama / vLLM / LM Studio) ship a non-empty default endpoint,
 * which counts as "configured" — so their cards showed up for everyone, empty, forever, whether or
 * not a local server was ever installed.
 *
 * The obvious fix — hide a local provider with zero models — breaks the only way to add the first
 * model, because the "Add model" dropdown is fed from the same list. Hence two lists: this rule
 * applies to the CARDS only, and the dropdown keeps every configured provider.
 */

export interface ProviderCardVisibilityInput<T extends string> {
	/** All configured providers, in display order. */
	readonly configured: readonly T[];
	/** How many models the provider currently has. */
	readonly modelCountOf: (provider: T) => number;
	/** Local providers are the ones that are "configured" purely by their default endpoint. */
	readonly isLocal: (provider: T) => boolean;
	/** User escape hatch: show local providers even when they have nothing in them. */
	readonly showEmptyLocal: boolean;
}

export function visibleProviderCards<T extends string>(input: ProviderCardVisibilityInput<T>): T[] {
	const { configured, modelCountOf, isLocal, showEmptyLocal } = input;
	if (showEmptyLocal) {
		return [...configured];
	}
	// A local provider with models is in use — it stays regardless of the setting.
	return configured.filter(p => !isLocal(p) || modelCountOf(p) > 0);
}
