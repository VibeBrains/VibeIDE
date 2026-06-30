/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * i18n LLM-assisted draft translations — pure helpers
 * (roadmap §"LLM-assisted draft переводы: команда `vibe i18n draft --locale
 * de --provider ollama` берёт `[NEEDS_TRANSLATION]` ключи, генерирует
 * черновики через локальную модель (privacy-режим compatible), создаёт PR с
 * `[DRAFT_LLM]` маркерами для ревью человеком. Никогда не коммитит
 * автоматически").
 *
 * Pure helpers — `vscode`-free. The CLI script (`scripts/vibe-i18n-draft.js`)
 * loads metadata + locale files, calls these helpers to:
 *   - select keys that need translation
 *   - format the LLM request payload (system + user prompt)
 *   - parse the LLM response back into key→draft map
 *   - apply `[DRAFT_LLM]` markers + write back
 * The actual `fetch()` to Ollama / LM Studio stays in the CLI runtime.
 */

const NEEDS_TRANSLATION_PREFIX = '[NEEDS_TRANSLATION]';
const DRAFT_LLM_PREFIX = '[DRAFT_LLM]';

export interface I18nDraftCandidate {
	readonly key: string;
	readonly englishSource: string;
}

/**
 * Select which keys need an LLM draft. Returns the subset of `metadataKeys`
 * whose current locale value is missing or carries the `[NEEDS_TRANSLATION]`
 * marker. Never touches keys that already have a real translation OR a
 * `[DRAFT_LLM]` marker (which means an earlier draft is awaiting review).
 *
 * Pure: no IO, deterministic sort by key.
 */
export function selectKeysForLLMDraft(
	metadataEnglish: ReadonlyMap<string, string>,
	currentLocale: ReadonlyMap<string, string>,
): readonly I18nDraftCandidate[] {
	const out: I18nDraftCandidate[] = [];
	for (const [key, englishSource] of metadataEnglish) {
		const current = currentLocale.get(key);
		if (current === undefined) {
			out.push({ key, englishSource });
			continue;
		}
		if (current.length === 0) {
			out.push({ key, englishSource });
			continue;
		}
		if (current.startsWith(NEEDS_TRANSLATION_PREFIX)) {
			out.push({ key, englishSource });
			continue;
		}
		// Already translated OR already has a DRAFT_LLM marker → skip.
	}
	out.sort((a, b) => a.key.localeCompare(b.key));
	return out;
}

export interface I18nDraftRequestPayload {
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly model: string;
	readonly localeName: string;
	readonly batchSize: number;
}

export interface I18nDraftRequestInput {
	readonly candidates: ReadonlyArray<I18nDraftCandidate>;
	readonly targetLocaleTag: string;
	/** Human-readable locale name passed into the prompt (e.g. "Russian"). */
	readonly targetLocaleName: string;
	readonly model: string;
	/** Maximum keys per LLM call — small batches avoid context-window blow-out. */
	readonly batchSize?: number;
}

/**
 * Build a single LLM request payload (system + user prompts). Pure formatter.
 *
 * The user prompt embeds the candidates as a numbered list with the key and
 * the English source so the model has *both* the identifier (for context
 * inference) and the literal text. The model is instructed to return JSON
 * lines `{key: "...", translation: "..."}` so parsing is forgiving.
 *
 * Caller chunks larger candidate arrays into `batchSize` slices and calls
 * this helper per slice.
 */
export function buildI18nDraftRequest(input: I18nDraftRequestInput): I18nDraftRequestPayload {
	const batchSize = clampBatchSize(input.batchSize);
	const slice = input.candidates.slice(0, batchSize);
	const systemPrompt =
		`You are a software-localisation translator. Translate the following UI strings into ${input.targetLocaleName} (${input.targetLocaleTag}).\n` +
		`Preserve all placeholders such as {0}, {1}, {key} — do NOT translate them.\n` +
		`Preserve leading/trailing whitespace exactly.\n` +
		`Return only valid JSON, no commentary.`;
	const list = slice.map((c, i) => `${i + 1}. key="${c.key}" english=${JSON.stringify(c.englishSource)}`).join('\n');
	const userPrompt =
		`Translate to ${input.targetLocaleName}:\n${list}\n\n` +
		`Respond with a JSON array of objects: [{"key": "...", "translation": "..."}, ...]`;
	return {
		systemPrompt,
		userPrompt,
		model: input.model,
		localeName: input.targetLocaleName,
		batchSize,
	};
}

function clampBatchSize(raw: number | undefined): number {
	const v = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 25;
	if (v < 1) { return 1; }
	if (v > 100) { return 100; }
	return v;
}

export type I18nDraftParseResult =
	| { readonly kind: 'ok'; readonly drafts: ReadonlyMap<string, string> }
	| { readonly kind: 'invalid-json'; readonly preview: string }
	| { readonly kind: 'shape-mismatch'; readonly reason: string };

/**
 * Parse an LLM response back into a `key → translation` map. Pure.
 *
 * Robust to:
 *   - leading/trailing prose ("Here's the translation:") — extracts the
 *     first JSON-looking substring (`[ ... ]`).
 *   - extra fields per object (only `key` and `translation` are read).
 *
 * Refuses:
 *   - non-array root
 *   - object missing `key` or `translation`
 *   - keys not in the candidate list (model hallucinated keys)
 */
export function parseI18nDraftResponse(
	rawResponse: string,
	expectedKeys: ReadonlySet<string>,
): I18nDraftParseResult {
	const jsonText = extractJsonArray(rawResponse);
	if (jsonText === null) {
		return { kind: 'invalid-json', preview: rawResponse.slice(0, 200) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return { kind: 'invalid-json', preview: jsonText.slice(0, 200) };
	}
	if (!Array.isArray(parsed)) {
		return { kind: 'shape-mismatch', reason: 'root-not-array' };
	}
	const drafts = new Map<string, string>();
	for (let i = 0; i < parsed.length; i++) {
		const item = parsed[i];
		if (!item || typeof item !== 'object') {
			return { kind: 'shape-mismatch', reason: `item[${i}]:not-object` };
		}
		const o = item as Record<string, unknown>;
		if (typeof o.key !== 'string' || o.key.length === 0) {
			return { kind: 'shape-mismatch', reason: `item[${i}]:key-missing` };
		}
		if (typeof o.translation !== 'string') {
			return { kind: 'shape-mismatch', reason: `item[${i}]:translation-missing` };
		}
		if (!expectedKeys.has(o.key)) {
			return { kind: 'shape-mismatch', reason: `item[${i}]:hallucinated-key:${o.key}` };
		}
		drafts.set(o.key, o.translation);
	}
	return { kind: 'ok', drafts };
}

function extractJsonArray(s: string): string | null {
	const start = s.indexOf('[');
	if (start === -1) { return null; }
	const end = s.lastIndexOf(']');
	if (end === -1 || end < start) { return null; }
	return s.slice(start, end + 1);
}

/**
 * Apply LLM drafts back to a locale bundle, prefixing each draft with
 * `[DRAFT_LLM]` so it's distinguishable from human review. Pure: returns a
 * new map; never mutates input.
 *
 * Drops empty translations (the model may genuinely refuse — surface to the
 * caller via `dropped[]` so the CLI can warn).
 */
export function applyI18nDraftMarkers(
	currentLocale: ReadonlyMap<string, string>,
	drafts: ReadonlyMap<string, string>,
): { readonly next: ReadonlyMap<string, string>; readonly dropped: readonly string[] } {
	const next = new Map(currentLocale);
	const dropped: string[] = [];
	for (const [key, draft] of drafts) {
		const trimmed = draft.trim();
		if (trimmed.length === 0) {
			dropped.push(key);
			continue;
		}
		next.set(key, `${DRAFT_LLM_PREFIX} ${trimmed}`);
	}
	return { next, dropped };
}

export const I18N_LLM_DRAFT_PREFIX = DRAFT_LLM_PREFIX;
export const I18N_LLM_NEEDS_TRANSLATION_PREFIX = NEEDS_TRANSLATION_PREFIX;
