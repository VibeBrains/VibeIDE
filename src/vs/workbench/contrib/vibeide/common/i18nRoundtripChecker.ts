/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * i18n round-trip checker — pure helper
 * (roadmap §"Acceptance — Тест `i18n-roundtrip.test.ts`: парсит все
 * `vibeide.nls.<locale>.json`, проверяет что (а) все ключи существуют в
 * metadata, (б) число `{0}/{1}`-плейсхолдеров совпадает с английским
 * источником").
 *
 * Pure helper — `vscode`-free — caller passes already-parsed JSON content
 * for the metadata + each locale bundle. Helper compares them and returns
 * a list of `RoundtripIssue` records. Companion to
 * `i18nPlaceholderValidator.ts` (which checks placeholder syntax inside a
 * single key); this module checks coverage and per-bundle invariants
 * across all locales.
 */

import { extractPlaceholders } from './i18nPlaceholderValidator.js';

export interface I18nRoundtripIssue {
	readonly localeTag: string;
	readonly key: string;
	readonly code:
	| 'orphan-key'
	| 'placeholder-count-mismatch'
	| 'empty-translation';
	readonly detail?: string;
}

export interface I18nRoundtripInput {
	/** key → English source string (from `vibeide.nls.metadata.json`). */
	readonly metadataEnglish: ReadonlyMap<string, string>;
	/** Per-locale: `localeTag` → `key → translation`. */
	readonly localeBundles: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export interface I18nRoundtripResult {
	readonly issues: readonly I18nRoundtripIssue[];
	readonly stats: {
		readonly totalLocales: number;
		readonly totalIssues: number;
		readonly perLocale: Readonly<Record<string, number>>;
	};
}

const NEEDS_TRANSLATION_PREFIX = '[NEEDS_TRANSLATION]';

/**
 * Pure: collect-all-issues round-trip audit.
 *
 *   - orphan-key                  → translation key is not in metadata
 *   - placeholder-count-mismatch  → `{0}/{1}` count differs from English source
 *   - empty-translation           → translation is empty (and not the
 *                                   `[NEEDS_TRANSLATION]` placeholder, which is
 *                                   *expected* during grace period)
 *
 * Keys present in metadata but absent from the locale are NOT issues here —
 * coverage is the responsibility of `i18nGracePeriodPolicy.decideI18nGate`.
 * That keeps the roundtrip checker focused on "translations that exist
 * shouldn't be malformed".
 *
 * Iteration is deterministic: locales sorted, then keys sorted.
 */
export function checkI18nRoundtrip(input: I18nRoundtripInput): I18nRoundtripResult {
	const issues: I18nRoundtripIssue[] = [];
	const perLocale: Record<string, number> = {};

	const localeTags = [...input.localeBundles.keys()].sort();
	for (const localeTag of localeTags) {
		const bundle = input.localeBundles.get(localeTag);
		if (!bundle) {
			perLocale[localeTag] = 0;
			continue;
		}
		let count = 0;
		const keys = [...bundle.keys()].sort();
		for (const key of keys) {
			const translation = bundle.get(key)!;

			if (!input.metadataEnglish.has(key)) {
				issues.push({ localeTag, key, code: 'orphan-key' });
				count++;
				continue;
			}

			if (translation.length === 0) {
				issues.push({ localeTag, key, code: 'empty-translation' });
				count++;
				continue;
			}

			// `[NEEDS_TRANSLATION]` placeholders are not malformations — they
			// are the documented grace-period state. Skip placeholder check.
			if (translation.startsWith(NEEDS_TRANSLATION_PREFIX)) {
				continue;
			}

			const english = input.metadataEnglish.get(key)!;
			const englishCount = extractPlaceholders(english).length;
			const translationCount = extractPlaceholders(translation).length;
			if (englishCount !== translationCount) {
				issues.push({
					localeTag,
					key,
					code: 'placeholder-count-mismatch',
					detail: `english=${englishCount} translation=${translationCount}`,
				});
				count++;
			}
		}
		perLocale[localeTag] = count;
	}

	return {
		issues,
		stats: {
			totalLocales: localeTags.length,
			totalIssues: issues.length,
			perLocale,
		},
	};
}

/**
 * Pure: helper for orphan rotation. When a metadata key disappears (rename /
 * deletion in source code) the translations should be moved to `_orphans.json`
 * rather than dropped — preserves human-translated work across refactors.
 *
 * Returns `{ keep, orphan }`: `keep` is the input bundle minus orphan keys;
 * `orphan` is the dropped pairs that the caller should append to
 * `_orphans.json` for the locale.
 */
export function partitionLocaleForOrphanMove(
	bundle: ReadonlyMap<string, string>,
	metadataKeys: ReadonlySet<string>,
): {
	readonly keep: ReadonlyMap<string, string>;
	readonly orphan: ReadonlyMap<string, string>;
} {
	const keep = new Map<string, string>();
	const orphan = new Map<string, string>();
	for (const [k, v] of bundle) {
		if (metadataKeys.has(k)) {
			keep.set(k, v);
		} else {
			orphan.set(k, v);
		}
	}
	return { keep, orphan };
}
