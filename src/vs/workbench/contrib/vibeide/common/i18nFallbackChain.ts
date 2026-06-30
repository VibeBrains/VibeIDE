/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * i18n fallback chain — pure resolver
 * (roadmap §"Pack VSIX → Fallback chain: `<locale>` → `<locale-base>` →
 * английский (default) → ключ. Никаких пустых строк в UI").
 *
 * Pure helper — `vscode`-free — so the resolution order can be unit-tested
 * without `vscode.l10n` or any bundle loader. Caller passes the requested
 * locale tag and a set of bundle snapshots; helper returns a tagged result
 * with the resolved string AND the source it came from (so the UI can show
 * a diagnostic banner during dev: «string came from key — translation
 * missing»).
 */

export interface LocaleBundle {
	/** Locale tag — `"ru"`, `"ru-by"`, `"qps-ploc"`, `"en"`, etc. */
	readonly localeTag: string;
	/** Translated key → translated value. Missing keys signal "no translation". */
	readonly entries: ReadonlyMap<string, string>;
}

export type FallbackSource =
	| 'requested-locale'
	| 'base-locale'
	| 'english-default'
	| 'key';

export interface ResolveLocalizedInput {
	readonly key: string;
	readonly englishDefault?: string;
	readonly requestedLocale: string;
	readonly bundles: ReadonlyArray<LocaleBundle>;
}

export interface ResolveLocalizedResult {
	readonly value: string;
	readonly source: FallbackSource;
}

/**
 * Resolve a localised string with the documented fallback chain:
 *
 *   1. `requestedLocale` exact match (`ru-by` → bundle `ru-by`)
 *   2. base locale of `requestedLocale` (`ru-by` → bundle `ru`)
 *   3. `englishDefault` (the second argument that `localize()` carries)
 *   4. the raw `key` itself — last-resort, never an empty string in UI
 *
 * Empty translations in a bundle are treated as MISSING — the resolver
 * skips to the next fallback rather than rendering nothing.
 *
 * `[NEEDS_TRANSLATION] …` placeholder values are also treated as MISSING so
 * the user never sees the developer-only marker (the placeholder validator
 * in `i18nPlaceholderValidator.ts` covers that on the build side).
 */
export function resolveLocalized(input: ResolveLocalizedInput): ResolveLocalizedResult {
	const target = normaliseLocale(input.requestedLocale);
	if (target.length > 0) {
		const direct = lookupInBundles(input.bundles, target, input.key);
		if (direct !== null) { return { value: direct, source: 'requested-locale' }; }
		const base = baseLocaleOf(target);
		if (base !== null && base !== target) {
			const baseHit = lookupInBundles(input.bundles, base, input.key);
			if (baseHit !== null) { return { value: baseHit, source: 'base-locale' }; }
		}
	}
	if (typeof input.englishDefault === 'string' && input.englishDefault.length > 0) {
		return { value: input.englishDefault, source: 'english-default' };
	}
	return { value: input.key, source: 'key' };
}

/**
 * Compute the base locale: `ru-by` → `ru`, `pt-BR` → `pt`. Returns `null`
 * for locales that already are root (`ru`, `en`). Pure.
 */
export function baseLocaleOf(localeTag: string): string | null {
	const tag = normaliseLocale(localeTag);
	const sep = tag.indexOf('-');
	if (sep === -1) { return null; }
	const base = tag.slice(0, sep);
	if (base.length === 0) { return null; }
	return base;
}

/** Normalise `RU_by` / `RU-BY` / `  ru-BY ` → `ru-by`. Pure. */
export function normaliseLocale(localeTag: string): string {
	if (typeof localeTag !== 'string') { return ''; }
	return localeTag.trim().toLowerCase().replace(/_/g, '-');
}

const NEEDS_TRANSLATION_PREFIX = '[NEEDS_TRANSLATION]';

function lookupInBundles(
	bundles: ReadonlyArray<LocaleBundle>,
	wantTag: string,
	key: string,
): string | null {
	for (const b of bundles) {
		if (normaliseLocale(b.localeTag) !== wantTag) { continue; }
		const v = b.entries.get(key);
		if (typeof v !== 'string') { return null; }
		if (v.length === 0) { return null; }
		if (v.startsWith(NEEDS_TRANSLATION_PREFIX)) { return null; }
		return v;
	}
	return null;
}
