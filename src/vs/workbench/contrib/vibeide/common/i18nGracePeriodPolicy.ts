/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * i18n CI gate — grace-period policy
 * (roadmap §"K.4 — Сменить policy `< 95% → fail` на `warning + grace period`").
 *
 * Pure decision helper — `vscode`-free — so the CI gate behaviour can be
 * unit-tested without invoking GitHub Actions. The CI workflow loads the
 * helper, computes the decision, and uses it to:
 *   - emit a sticky PR comment with the diff
 *   - fail (red ✗) only on regressions of *existing* translations
 *   - warn (yellow ⚠) on new untranslated strings
 *
 * Policy:
 *   - Existing key disappears from `<locale>.json` (regressed)            → FAIL
 *   - New `localize()` key in metadata, missing/`[NEEDS_TRANSLATION]`     → WARN
 *   - Coverage drops below configured floor BUT only because of new keys  → WARN
 *   - Coverage drops below floor because of regression                    → FAIL
 *   - Otherwise                                                            → OK
 */

export interface I18nLocaleSnapshot {
	/** Localised key → translated value (omit `[NEEDS_TRANSLATION]` strings). */
	readonly translatedKeys: ReadonlySet<string>;
	/** Localised key → `[NEEDS_TRANSLATION] <english>` placeholders. */
	readonly needsTranslationKeys: ReadonlySet<string>;
}

export interface I18nGateInput {
	/** All `localize(key, ...)` keys discovered in the metadata. */
	readonly metadataKeys: ReadonlySet<string>;
	/** Snapshot from the *previous* commit / base branch. */
	readonly baseSnapshot: I18nLocaleSnapshot | null;
	/** Snapshot from the *current* commit / PR head. */
	readonly headSnapshot: I18nLocaleSnapshot;
	/** Coverage floor — usually 0.95 by historical convention. */
	readonly coverageFloor: number;
}

export type I18nGateVerdict = 'ok' | 'warn' | 'fail';

export interface I18nGateDecision {
	readonly verdict: I18nGateVerdict;
	readonly coverage: number;
	readonly newUntranslatedKeys: readonly string[];
	readonly regressedKeys: readonly string[];
	readonly reasons: readonly string[];
}

/**
 * Compute the gate verdict.
 *
 *   - Regressed keys (existing translation gone): FAIL — do not let merges
 *     silently delete prior work.
 *   - New untranslated keys: WARN — merging is OK; auto-fill with
 *     `[NEEDS_TRANSLATION]` placeholders is the developer's responsibility
 *     before next localisation pass.
 *   - Coverage below floor only because of new keys: WARN.
 *   - Coverage below floor and there are regressions: FAIL.
 */
export function decideI18nGate(input: I18nGateInput): I18nGateDecision {
	const { metadataKeys, baseSnapshot, headSnapshot, coverageFloor } = input;
	const totalKeys = metadataKeys.size;
	const translated = countTranslated(metadataKeys, headSnapshot);
	const coverage = totalKeys === 0 ? 1 : translated / totalKeys;

	const newUntranslated: string[] = [];
	for (const k of metadataKeys) {
		if (headSnapshot.translatedKeys.has(k)) {
			continue;
		}
		newUntranslated.push(k);
	}
	newUntranslated.sort();

	const regressed: string[] = [];
	if (baseSnapshot !== null) {
		for (const k of baseSnapshot.translatedKeys) {
			if (metadataKeys.has(k) && !headSnapshot.translatedKeys.has(k)) {
				regressed.push(k);
			}
		}
		regressed.sort();
	}

	const reasons: string[] = [];
	if (regressed.length > 0) {
		reasons.push(`regressed:${regressed.length}`);
	}
	if (newUntranslated.length > 0) {
		reasons.push(`new-untranslated:${newUntranslated.length}`);
	}
	const belowFloor = coverage + 1e-9 < coverageFloor;
	if (belowFloor) {
		reasons.push(`below-floor:${(coverage * 100).toFixed(1)}%<${(coverageFloor * 100).toFixed(1)}%`);
	}

	let verdict: I18nGateVerdict = 'ok';
	if (regressed.length > 0) {
		verdict = 'fail';
	} else if (newUntranslated.length > 0 || belowFloor) {
		verdict = 'warn';
	}

	return {
		verdict,
		coverage,
		newUntranslatedKeys: newUntranslated,
		regressedKeys: regressed,
		reasons,
	};
}

function countTranslated(metadataKeys: ReadonlySet<string>, snapshot: I18nLocaleSnapshot): number {
	let n = 0;
	for (const k of metadataKeys) {
		if (snapshot.translatedKeys.has(k)) {
			n++;
		}
	}
	return n;
}

/**
 * Auto-fill helper for the pre-commit hook (companion of K.4 line 943): given
 * the metadata keys and the current `<locale>.json` snapshot, returns the keys
 * that should be appended with the `[NEEDS_TRANSLATION] <english>` marker.
 *
 * Caller looks up the english source for each returned key and persists.
 */
export function findKeysNeedingPlaceholder(
	metadataKeys: ReadonlySet<string>,
	headSnapshot: I18nLocaleSnapshot,
): readonly string[] {
	const out: string[] = [];
	for (const k of metadataKeys) {
		if (!headSnapshot.translatedKeys.has(k) && !headSnapshot.needsTranslationKeys.has(k)) {
			out.push(k);
		}
	}
	out.sort();
	return out;
}

/**
 * RU-localised PR comment body. Pure formatter — caller posts via gh CLI.
 */
export function describeI18nGate(decision: I18nGateDecision, locale: string): string {
	const verdictIcon = decision.verdict === 'ok' ? '✅' : decision.verdict === 'warn' ? '⚠️' : '❌';
	const lines: string[] = [];
	lines.push(`${verdictIcon} **i18n coverage (${locale})**: ${(decision.coverage * 100).toFixed(1)}%`);
	if (decision.regressedKeys.length > 0) {
		lines.push('');
		lines.push(`### ❌ Регрессии (${decision.regressedKeys.length})`);
		lines.push('Эти ключи **были переведены** в base, но пропали в этом PR:');
		for (const k of decision.regressedKeys.slice(0, 20)) {
			lines.push(`- \`${k}\``);
		}
		if (decision.regressedKeys.length > 20) {
			lines.push(`- …и ещё ${decision.regressedKeys.length - 20}`);
		}
	}
	if (decision.newUntranslatedKeys.length > 0) {
		lines.push('');
		lines.push(`### ⚠️ Новые непереведённые (${decision.newUntranslatedKeys.length})`);
		lines.push('Не блокирует merge; будут помечены `[NEEDS_TRANSLATION]` при следующем `vibe i18n sync`.');
		for (const k of decision.newUntranslatedKeys.slice(0, 20)) {
			lines.push(`- \`${k}\``);
		}
		if (decision.newUntranslatedKeys.length > 20) {
			lines.push(`- …и ещё ${decision.newUntranslatedKeys.length - 20}`);
		}
	}
	return lines.join('\n');
}
