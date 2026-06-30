/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Category matching for the VibeIDE logger (roadmap #3115). After the logging migration there are
 * ~150 flat category names (one per source file), which makes the `vibeide.logging.categories`
 * allowlist and `categoryLevels` overrides unwieldy — you had to list every exact name.
 *
 * These helpers add OPT-IN prefix wildcards: a pattern ending in `*` matches any category whose
 * name starts with the prefix before it (e.g. `chat*` covers `chatThread`, `chatThreadService`, …).
 * Plain names without `*` keep their exact-match semantics, so existing configs are unaffected.
 *
 * Pure / deterministic. The hot path (`passes`) does the O(1) exact check itself and only calls the
 * wildcard scan on a miss, so adding this costs nothing when no wildcards are configured.
 */

/** True if `pattern` matches `category`: exact equality, or a `prefix*` wildcard the category starts with. */
export const logCategoryMatchesPattern = (category: string, pattern: string): boolean => {
	if (pattern.endsWith('*')) {
		return category.startsWith(pattern.slice(0, -1));
	}
	return category === pattern;
};

/**
 * Allowlist check. Empty / null set = everything passes. Otherwise the category must match some
 * pattern. Exact membership is tried first (O(1)); the wildcard scan runs only on a miss.
 */
export const logCategoryAllowed = (category: string, patterns: ReadonlySet<string> | null | undefined): boolean => {
	if (!patterns || patterns.size === 0) { return true; }
	if (patterns.has(category)) { return true; }
	for (const p of patterns) {
		if (p.endsWith('*') && category.startsWith(p.slice(0, -1))) { return true; }
	}
	return false;
};

/**
 * Find the WILDCARD level-override key that applies to a category, most-specific first (longest
 * prefix wins). Exact-name keys are handled by the caller's direct map lookup — this only resolves
 * `prefix*` keys, and is meant to run only when the exact lookup missed. Returns undefined if none.
 */
export const resolveCategoryLevelWildcard = (category: string, keys: Iterable<string>): string | undefined => {
	let best: string | undefined;
	let bestLen = -1;
	for (const k of keys) {
		if (k.endsWith('*') && category.startsWith(k.slice(0, -1))) {
			const len = k.length - 1;
			if (len > bestLen) { bestLen = len; best = k; }
		}
	}
	return best;
};
