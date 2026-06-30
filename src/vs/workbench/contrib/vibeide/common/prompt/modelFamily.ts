/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Coarse-grained classification of the upstream LLM family. Used as a single
 * pivot for family-specific prompt quirks. Resolution is deliberately conservative:
 * if we can't confidently identify a family, we return 'default'. Callers must not
 * treat 'default' as "openai-compatible" — it's a fallback meaning "unknown".
 *
 * This is infrastructure, not a switch board: the only consumer for now is the
 * prompt builder, which accepts the value as a hint for future per-family tuning.
 */
export type ModelFamily = 'anthropic' | 'gpt' | 'gemini' | 'default';

export type SpecialToolFormat = 'openai-style' | 'anthropic-style' | 'gemini-style' | undefined;

/**
 * Resolve the model family from a (providerName, modelName, specialToolFormat)
 * triple. Direct cloud providers map by name. Aggregators (openCodeGo, openRouter,
 * liteLLM, openCodeZen, lmRoute, openAICompatible, pollinations) fall back to
 * a name-substring heuristic over `modelName`. If both fail, the `specialToolFormat`
 * acts as a last-resort hint.
 *
 * The provider list intentionally matches the production set in `modelCapabilities.ts`;
 * keep them in sync when adding new direct providers.
 */
export const detectModelFamily = (
	providerName: string | undefined,
	modelName: string | undefined,
	specialToolFormat: SpecialToolFormat
): ModelFamily => {
	// 1. Direct cloud providers — authoritative.
	switch (providerName) {
		case 'anthropic':
		case 'awsBedrock':
			return 'anthropic';
		case 'gemini':
		case 'googleVertex':
			return 'gemini';
		case 'openAI':
		case 'microsoftAzure':
			return 'gpt';
	}

	// 2. Aggregator path — sniff the model name. Lowercase once.
	const m = (modelName ?? '').toLowerCase();
	if (m) {
		if (m.includes('claude') || m.includes('anthropic')) { return 'anthropic'; }
		if (m.includes('gemini') || m.includes('palm') || m.includes('bison')) { return 'gemini'; }
		if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4') || m.includes('chatgpt')) { return 'gpt'; }
	}

	// 3. Last-resort hint from specialToolFormat. Coarse, but better than nothing.
	switch (specialToolFormat) {
		case 'anthropic-style': return 'anthropic';
		case 'gemini-style': return 'gemini';
		case 'openai-style': return 'gpt';
	}

	return 'default';
};
