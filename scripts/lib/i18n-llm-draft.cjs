/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CJS port of `common/i18nLLMDraft.ts` for `scripts/vibe-i18n-draft.js`.

'use strict';

const NEEDS_TRANSLATION_PREFIX = '[NEEDS_TRANSLATION]';
const DRAFT_LLM_PREFIX = '[DRAFT_LLM]';

/**
 * @param {Map<string,string>} metadataEnglish
 * @param {Map<string,string>} currentLocale
 * @returns {Array<{key:string, englishSource:string}>}
 */
function selectKeysForLLMDraft(metadataEnglish, currentLocale) {
	const out = [];
	for (const [key, englishSource] of metadataEnglish) {
		const current = currentLocale.get(key);
		if (current === undefined || current.length === 0 || current.startsWith(NEEDS_TRANSLATION_PREFIX)) {
			out.push({ key, englishSource });
		}
	}
	out.sort((a, b) => a.key.localeCompare(b.key));
	return out;
}

/**
 * @param {{ candidates: Array<{key,englishSource}>, targetLocaleTag: string, targetLocaleName: string, model: string, batchSize?: number }} input
 */
function buildI18nDraftRequest(input) {
	const batchSize = Math.max(1, Math.min(input.batchSize ?? 20, 100));
	const batch = input.candidates.slice(0, batchSize);

	const systemPrompt =
		`You are a professional software localisation translator. ` +
		`Translate each UI string from English to ${input.targetLocaleName} (locale: ${input.targetLocaleTag}). ` +
		`Rules: ` +
		`1. Preserve {0}, {1}, … placeholder tokens exactly as-is. ` +
		`2. Preserve Markdown formatting (**, \`code\`, etc.). ` +
		`3. Return ONLY a JSON object: { "key1": "translation1", … } — no prose, no code fences.`;

	const userPrompt = JSON.stringify(
		Object.fromEntries(batch.map(c => [c.key, c.englishSource])),
		null, 2,
	);

	return { systemPrompt, userPrompt, model: input.model, localeName: input.targetLocaleName, batchSize };
}

/**
 * @param {string} rawResponse
 * @returns {{ kind: 'ok', translations: Map<string,string> } | { kind: 'no-json' } | { kind: 'shape-mismatch', detail: string }}
 */
function parseI18nDraftResponse(rawResponse) {
	let jsonStr = rawResponse.trim();
	// Extract JSON from prose wrapping if needed
	const firstBrace = jsonStr.indexOf('{');
	const lastBrace = jsonStr.lastIndexOf('}');
	if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
		jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
	}
	let parsed;
	try { parsed = JSON.parse(jsonStr); } catch {
		return { kind: 'no-json' };
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { kind: 'shape-mismatch', detail: 'Expected a top-level JSON object' };
	}
	const translations = new Map();
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== 'string') {
			return { kind: 'shape-mismatch', detail: `Value for key "${key}" is not a string` };
		}
		translations.set(key, value);
	}
	return { kind: 'ok', translations };
}

/**
 * Apply draft markers to an existing locale bundle.
 * @param {Map<string,string>} bundle
 * @param {Map<string,string>} drafts
 * @returns {Map<string,string>}
 */
function applyI18nDraftMarkers(bundle, drafts) {
	const result = new Map(bundle);
	for (const [key, draft] of drafts) {
		const trimmed = draft.trim();
		if (trimmed.length === 0) continue;
		result.set(key, `${DRAFT_LLM_PREFIX} ${trimmed}`);
	}
	return result;
}

module.exports = {
	selectKeysForLLMDraft,
	buildI18nDraftRequest,
	parseI18nDraftResponse,
	applyI18nDraftMarkers,
	I18N_LLM_DRAFT_PREFIX: DRAFT_LLM_PREFIX,
	I18N_LLM_NEEDS_TRANSLATION_PREFIX: NEEDS_TRANSLATION_PREFIX,
};
