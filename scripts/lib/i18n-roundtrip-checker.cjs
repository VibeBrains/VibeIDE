/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CJS port of `common/i18nRoundtripChecker.ts` for `scripts/vibe-i18n-roundtrip.js`.
// Checks orphan-key / placeholder-count-mismatch / empty-translation across locale bundles.

'use strict';

const NEEDS_TRANSLATION_PREFIX = '[NEEDS_TRANSLATION]';

function extractPlaceholders(str) {
	const matches = str.match(/\{(\d+)\}/g) ?? [];
	const indices = new Set(matches.map(m => parseInt(m.slice(1, -1), 10)));
	return indices;
}

/**
 * @param {{ metadataEnglish: Map<string, string>, localeBundles: Map<string, Map<string, string>> }} input
 * @returns {{ issues: Array<{localeTag,key,code,detail}>, stats: {totalLocales,totalIssues,perLocale} }}
 */
function checkI18nRoundtrip(input) {
	const issues = [];
	const perLocale = {};

	const localeTags = [...input.localeBundles.keys()].sort();
	for (const localeTag of localeTags) {
		const bundle = input.localeBundles.get(localeTag);
		if (!bundle) { perLocale[localeTag] = 0; continue; }
		let count = 0;
		const keys = [...bundle.keys()].sort();
		for (const key of keys) {
			const translation = bundle.get(key);
			if (translation === undefined) continue;

			if (!input.metadataEnglish.has(key)) {
				issues.push({ localeTag, key, code: 'orphan-key', detail: 'key not in metadata' });
				count++;
				continue;
			}

			if (translation.startsWith(NEEDS_TRANSLATION_PREFIX)) continue;

			if (translation.trim().length === 0) {
				issues.push({ localeTag, key, code: 'empty-translation' });
				count++;
				continue;
			}

			const englishSource = input.metadataEnglish.get(key);
			const englishPH = extractPlaceholders(englishSource);
			const translationPH = extractPlaceholders(translation);
			if (englishPH.size !== translationPH.size) {
				issues.push({
					localeTag, key, code: 'placeholder-count-mismatch',
					detail: `English has ${englishPH.size} placeholder(s), translation has ${translationPH.size}`,
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
 * Partition locale bundle into keep + orphans.
 * @param {Map<string, string>} bundle
 * @param {Map<string, string>} metadataEnglish
 */
function partitionLocaleForOrphanMove(bundle, metadataEnglish) {
	const keep = new Map();
	const orphans = new Map();
	for (const [key, value] of bundle) {
		if (metadataEnglish.has(key)) keep.set(key, value);
		else orphans.set(key, value);
	}
	return { keep, orphans };
}

module.exports = { checkI18nRoundtrip, partitionLocaleForOrphanMove };
