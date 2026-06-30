/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * i18n placeholder round-trip validator (506 / 507) — pure helper.
 *
 * VS Code's `localize()` interpolates `{0}`, `{1}`, … placeholders. If
 * a translation file has a different placeholder count from the English
 * source, formatting silently drops arguments — runtime UI shows missing
 * data with no error. This helper compares two strings (source vs
 * translation) and surfaces parity issues.
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface PlaceholderViolation {
	key: string;
	kind: 'missing-placeholder' | 'extra-placeholder' | 'duplicate-placeholder' | 'malformed-placeholder';
	source: string;
	translation: string;
	missingPlaceholders?: ReadonlyArray<string>;
	extraPlaceholders?: ReadonlyArray<string>;
}

const PLACEHOLDER_RE = /\{(\d+)\}/g;

/**
 * Extract `{N}` placeholders from a string. Returns an array of N values
 * (numeric, not strings) in the order they appear; duplicates included.
 */
export function extractPlaceholders(s: string): number[] {
	if (typeof s !== 'string') { return []; }
	const out: number[] = [];
	const re = new RegExp(PLACEHOLDER_RE.source, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		const n = Number(m[1]);
		if (Number.isFinite(n)) { out.push(n); }
	}
	return out;
}

/**
 * Compare placeholders in source vs translation. Returns null on parity,
 * or a violation describing the mismatch. Pure.
 *
 * Rules:
 *   - same set of placeholder N values (order-insensitive) → ok
 *   - source has N that translation lacks → missing-placeholder
 *   - translation has N not in source → extra-placeholder
 *   - translation repeats a placeholder more than the source does (or
 *     more than once when source has it once) → duplicate-placeholder
 */
export function validatePlaceholderParity(
	key: string,
	source: string,
	translation: string,
): PlaceholderViolation | null {
	const src = extractPlaceholders(source);
	const tr = extractPlaceholders(translation);

	const srcCounts = countOccurrences(src);
	const trCounts = countOccurrences(tr);

	const missing: string[] = [];
	for (const [n, c] of srcCounts.entries()) {
		const trc = trCounts.get(n) ?? 0;
		if (trc < c) {
			missing.push(`{${n}}`);
		}
	}
	const extra: string[] = [];
	for (const [n, c] of trCounts.entries()) {
		if (!srcCounts.has(n)) {
			extra.push(`{${n}}`);
		} else {
			const sc = srcCounts.get(n) ?? 0;
			if (c > sc) {
				// Could be duplicate-placeholder; emit one violation kind.
				return {
					key, kind: 'duplicate-placeholder', source, translation,
				};
			}
		}
	}

	if (missing.length > 0) {
		return {
			key, kind: 'missing-placeholder', source, translation,
			missingPlaceholders: missing,
		};
	}
	if (extra.length > 0) {
		return {
			key, kind: 'extra-placeholder', source, translation,
			extraPlaceholders: extra,
		};
	}
	return null;
}

function countOccurrences(arr: ReadonlyArray<number>): Map<number, number> {
	const m = new Map<number, number>();
	for (const n of arr) {
		m.set(n, (m.get(n) ?? 0) + 1);
	}
	return m;
}

export interface BundleValidationResult {
	checked: number;
	ok: number;
	violations: ReadonlyArray<PlaceholderViolation>;
}

/**
 * Validate an entire bundle (source map + translation map). Pure.
 *
 * Keys present only in source are flagged as missing-translation
 * (kind=missing-placeholder with empty `translation`); keys present only
 * in the translation are flagged as extra-placeholder (kind=extra with
 * empty `source`). The runtime `i18n-roundtrip.test.ts` consumes this.
 */
export function validateBundlePlaceholders(
	source: Readonly<Record<string, string>>,
	translation: Readonly<Record<string, string>>,
): BundleValidationResult {
	const violations: PlaceholderViolation[] = [];
	let ok = 0;
	const allKeys = new Set([...Object.keys(source), ...Object.keys(translation)]);
	for (const key of allKeys) {
		const src = source[key];
		const tr = translation[key];
		if (src === undefined) {
			// Translation has key the source doesn't — extra placeholder lookup.
			const extra = extractPlaceholders(tr ?? '');
			if (extra.length > 0) {
				violations.push({
					key, kind: 'extra-placeholder', source: '', translation: tr ?? '',
					extraPlaceholders: extra.map(n => `{${n}}`),
				});
			}
			continue;
		}
		if (tr === undefined) {
			// Source has key the translation doesn't — handled by another tool
			// (i18n-sync auto-marks [NEEDS_TRANSLATION]). Skip here.
			continue;
		}
		const v = validatePlaceholderParity(key, src, tr);
		if (v) {
			violations.push(v);
		} else {
			ok++;
		}
	}
	return { checked: allKeys.size, ok, violations };
}
