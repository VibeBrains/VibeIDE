/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VS Code NLS (`@vscode/l10n-dev`) adapter — typed contract
 * (roadmap §"Pack VSIX → Layout: использовать стандартный VS Code NLS-механизм
 * (`build/lib/i18n.ts` уже импортирует `@vscode/l10n-dev` — переиспользуем
 * `getL10nXlf`/`getL10nFilesFromXlf`)").
 *
 * Pure helpers — `vscode`-free. The actual `@vscode/l10n-dev` calls live in
 * `build/lib/i18n.ts`; this module is the typed contract for what the gulp
 * pipeline produces and consumes — so callers can drive the pipeline from
 * VibeIDE-side code without touching the build/ tree.
 */

const KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_./-]*$/;
const LOCALE_TAG_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;

export interface XlfTransUnit {
	readonly key: string;
	readonly source: string;
	readonly target?: string;
	readonly note?: string;
}

export interface XlfFile {
	readonly sourceLocale: string;
	readonly targetLocale: string;
	readonly bundleName: string;
	readonly transUnits: readonly XlfTransUnit[];
}

export type DecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

/**
 * Validate the typed XLF shape produced by `@vscode/l10n-dev:getL10nXlf`.
 * Pure — caller has parsed the XML into an object via the upstream lib.
 */
export function decodeXlfFile(raw: unknown): DecodeResult<XlfFile> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const o = raw as Record<string, unknown>;

	if (typeof o.sourceLocale !== 'string' || !LOCALE_TAG_PATTERN.test(o.sourceLocale)) {
		return { ok: false, reason: 'sourceLocale-invalid' };
	}
	if (typeof o.targetLocale !== 'string' || !LOCALE_TAG_PATTERN.test(o.targetLocale)) {
		return { ok: false, reason: 'targetLocale-invalid' };
	}
	if (typeof o.bundleName !== 'string' || o.bundleName.length === 0) {
		return { ok: false, reason: 'bundleName-empty' };
	}
	if (!Array.isArray(o.transUnits)) {
		return { ok: false, reason: 'transUnits-not-array' };
	}

	const units: XlfTransUnit[] = [];
	const seenKeys = new Set<string>();
	for (let i = 0; i < o.transUnits.length; i++) {
		const u = decodeTransUnit(o.transUnits[i]);
		if (!u.ok) { return { ok: false, reason: `transUnits[${i}]:${u.reason}` }; }
		if (seenKeys.has(u.value.key)) { return { ok: false, reason: `transUnits[${i}]:duplicate-key:${u.value.key}` }; }
		seenKeys.add(u.value.key);
		units.push(u.value);
	}

	return {
		ok: true,
		value: {
			sourceLocale: o.sourceLocale.toLowerCase(),
			targetLocale: o.targetLocale.toLowerCase(),
			bundleName: o.bundleName,
			transUnits: units,
		},
	};
}

function decodeTransUnit(raw: unknown): DecodeResult<XlfTransUnit> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-object' }; }
	const o = raw as Record<string, unknown>;
	if (typeof o.key !== 'string' || !KEY_PATTERN.test(o.key)) { return { ok: false, reason: 'key-invalid' }; }
	if (typeof o.source !== 'string') { return { ok: false, reason: 'source-not-string' }; }
	if (o.target !== undefined && typeof o.target !== 'string') { return { ok: false, reason: 'target-not-string' }; }
	if (o.note !== undefined && typeof o.note !== 'string') { return { ok: false, reason: 'note-not-string' }; }
	const out: XlfTransUnit = {
		key: o.key,
		source: o.source,
		...(typeof o.target === 'string' ? { target: o.target } : {}),
		...(typeof o.note === 'string' && o.note.length > 0 ? { note: o.note } : {}),
	};
	return { ok: true, value: out };
}

/**
 * Build the input shape for `getL10nXlf` — given a metadata bundle (key→
 * english source) plus an optional translation map (key→target), return the
 * `XlfFile` that the upstream lib serialises to disk.
 *
 * Pure — caller passes the source/target maps that the gulp task already
 * has loaded. Refuses on locale mismatch (sourceLocale === targetLocale)
 * since that produces a useless XLF file.
 */
export function buildXlfFile(input: {
	readonly sourceLocale: string;
	readonly targetLocale: string;
	readonly bundleName: string;
	readonly metadataEnglish: ReadonlyMap<string, string>;
	readonly translations?: ReadonlyMap<string, string>;
}): DecodeResult<XlfFile> {
	if (typeof input.sourceLocale !== 'string' || !LOCALE_TAG_PATTERN.test(input.sourceLocale)) {
		return { ok: false, reason: 'sourceLocale-invalid' };
	}
	if (typeof input.targetLocale !== 'string' || !LOCALE_TAG_PATTERN.test(input.targetLocale)) {
		return { ok: false, reason: 'targetLocale-invalid' };
	}
	const sourceLow = input.sourceLocale.toLowerCase();
	const targetLow = input.targetLocale.toLowerCase();
	if (sourceLow === targetLow) {
		return { ok: false, reason: 'source-and-target-equal' };
	}
	if (typeof input.bundleName !== 'string' || input.bundleName.length === 0) {
		return { ok: false, reason: 'bundleName-empty' };
	}

	const sortedKeys = [...input.metadataEnglish.keys()].sort();
	const transUnits: XlfTransUnit[] = [];
	for (const key of sortedKeys) {
		if (!KEY_PATTERN.test(key)) { continue; }
		const source = input.metadataEnglish.get(key)!;
		const target = input.translations?.get(key);
		transUnits.push({
			key,
			source,
			...(typeof target === 'string' && target.length > 0 ? { target } : {}),
		});
	}

	return {
		ok: true,
		value: {
			sourceLocale: sourceLow,
			targetLocale: targetLow,
			bundleName: input.bundleName,
			transUnits,
		},
	};
}

/**
 * Extract a `key → target` map from a parsed XLF file (the inverse of
 * `buildXlfFile`). Produced by `getL10nFilesFromXlf` upstream-side; the
 * pure helper here builds the final locale bundle that gets written to
 * `vibeide.nls.<locale>.json`.
 *
 * Untranslated entries (no `target`) are dropped — caller decides whether
 * to fill them with `[NEEDS_TRANSLATION]` (use `findKeysNeedingPlaceholder`
 * from `i18nGracePeriodPolicy`) or leave them out entirely.
 */
export function extractTranslationsFromXlf(file: XlfFile): ReadonlyMap<string, string> {
	const out = new Map<string, string>();
	for (const u of file.transUnits) {
		if (typeof u.target !== 'string' || u.target.length === 0) { continue; }
		out.set(u.key, u.target);
	}
	return out;
}

/**
 * Compute the diff between two XLF files (different versions of the same
 * locale bundle). Returns the per-key change set; useful for CI gating.
 */
export function diffXlfFiles(
	previous: XlfFile,
	current: XlfFile,
): {
	readonly added: readonly string[];
	readonly modified: readonly string[];
	readonly removed: readonly string[];
	readonly localeChanged: boolean;
} {
	const localeChanged = previous.sourceLocale !== current.sourceLocale
		|| previous.targetLocale !== current.targetLocale;

	const prevByKey = new Map<string, XlfTransUnit>();
	for (const u of previous.transUnits) { prevByKey.set(u.key, u); }

	const added: string[] = [];
	const modified: string[] = [];
	const removed: string[] = [];

	for (const u of current.transUnits) {
		const prev = prevByKey.get(u.key);
		if (prev === undefined) {
			added.push(u.key);
			continue;
		}
		if (prev.source !== u.source || prev.target !== u.target) {
			modified.push(u.key);
		}
	}
	for (const u of previous.transUnits) {
		if (!current.transUnits.some(c => c.key === u.key)) {
			removed.push(u.key);
		}
	}

	added.sort();
	modified.sort();
	removed.sort();

	return { added, modified, removed, localeChanged };
}
