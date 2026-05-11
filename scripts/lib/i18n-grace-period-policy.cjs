// CJS mirror of src/vs/workbench/contrib/vibeide/common/i18nGracePeriodPolicy.ts
// MUST stay in sync with the TS source.
'use strict';

// @ts-check

/**
 * @typedef {{ translatedKeys: Set<string>; needsTranslationKeys: Set<string> }} I18nLocaleSnapshot
 * @typedef {{ metadataKeys: Set<string>; baseSnapshot: I18nLocaleSnapshot | null; headSnapshot: I18nLocaleSnapshot; coverageFloor: number }} I18nGateInput
 * @typedef {'ok'|'warn'|'fail'} I18nGateVerdict
 * @typedef {{ verdict: I18nGateVerdict; coverage: number; newUntranslatedKeys: string[]; regressedKeys: string[]; reasons: string[] }} I18nGateDecision
 */

/**
 * @param {Set<string>} metadataKeys
 * @param {I18nLocaleSnapshot} snapshot
 */
function countTranslated(metadataKeys, snapshot) {
	let n = 0;
	for (const k of metadataKeys) {
		if (snapshot.translatedKeys.has(k)) { n++; }
	}
	return n;
}

/**
 * @param {I18nGateInput} input
 * @returns {I18nGateDecision}
 */
function decideI18nGate(input) {
	const { metadataKeys, baseSnapshot, headSnapshot, coverageFloor } = input;
	const totalKeys = metadataKeys.size;
	const translated = countTranslated(metadataKeys, headSnapshot);
	const coverage = totalKeys === 0 ? 1 : translated / totalKeys;

	/** @type {string[]} */
	const newUntranslated = [];
	for (const k of metadataKeys) {
		if (!headSnapshot.translatedKeys.has(k)) {
			newUntranslated.push(k);
		}
	}
	newUntranslated.sort();

	/** @type {string[]} */
	const regressed = [];
	if (baseSnapshot !== null) {
		for (const k of baseSnapshot.translatedKeys) {
			if (metadataKeys.has(k) && !headSnapshot.translatedKeys.has(k)) {
				regressed.push(k);
			}
		}
		regressed.sort();
	}

	const reasons = [];
	if (regressed.length > 0) { reasons.push(`regressed:${regressed.length}`); }
	if (newUntranslated.length > 0) { reasons.push(`new-untranslated:${newUntranslated.length}`); }
	const belowFloor = coverage + 1e-9 < coverageFloor;
	if (belowFloor) { reasons.push(`below-floor:${(coverage * 100).toFixed(1)}%<${(coverageFloor * 100).toFixed(1)}%`); }

	/** @type {I18nGateVerdict} */
	let verdict = 'ok';
	if (regressed.length > 0) {
		verdict = 'fail';
	} else if (newUntranslated.length > 0 || belowFloor) {
		verdict = 'warn';
	}

	return { verdict, coverage, newUntranslatedKeys: newUntranslated, regressedKeys: regressed, reasons };
}

/**
 * Build an I18nLocaleSnapshot from the parsed contents of `vibeide.nls.<locale>.json`.
 * The NLS bundle format is a flat `{ "<key>": "<translated>" }` object;
 * `[NEEDS_TRANSLATION]` values are treated as untranslated placeholders.
 *
 * @param {Record<string,string>} nlsBundle
 * @returns {I18nLocaleSnapshot}
 */
function snapshotFromNlsBundle(nlsBundle) {
	const translatedKeys = new Set();
	const needsTranslationKeys = new Set();
	for (const [k, v] of Object.entries(nlsBundle)) {
		if (typeof v === 'string' && v.startsWith('[NEEDS_TRANSLATION]')) {
			needsTranslationKeys.add(k);
		} else {
			translatedKeys.add(k);
		}
	}
	return { translatedKeys, needsTranslationKeys };
}

/**
 * @param {I18nGateDecision} decision
 * @param {string} locale
 * @returns {string}
 */
function describeI18nGate(decision, locale) {
	const icon = decision.verdict === 'ok' ? '✅' : decision.verdict === 'warn' ? '⚠️' : '❌';
	const lines = [];
	lines.push(`${icon} **i18n coverage (${locale})**: ${(decision.coverage * 100).toFixed(1)}%`);
	if (decision.regressedKeys.length > 0) {
		lines.push('');
		lines.push(`### ❌ Регрессии (${decision.regressedKeys.length})`);
		lines.push('Эти ключи **были переведены** в base, но пропали в этом PR:');
		for (const k of decision.regressedKeys.slice(0, 20)) { lines.push(`- \`${k}\``); }
		if (decision.regressedKeys.length > 20) { lines.push(`- …и ещё ${decision.regressedKeys.length - 20}`); }
	}
	if (decision.newUntranslatedKeys.length > 0) {
		lines.push('');
		lines.push(`### ⚠️ Новые непереведённые (${decision.newUntranslatedKeys.length})`);
		lines.push('Не блокирует merge; будут помечены `[NEEDS_TRANSLATION]` при следующем `vibe i18n sync`.');
		for (const k of decision.newUntranslatedKeys.slice(0, 20)) { lines.push(`- \`${k}\``); }
		if (decision.newUntranslatedKeys.length > 20) { lines.push(`- …и ещё ${decision.newUntranslatedKeys.length - 20}`); }
	}
	return lines.join('\n');
}

// Self-tests (node:assert, zero-dep).
if (require.main === module) {
	const assert = require('node:assert/strict');

	const base = snapshotFromNlsBundle({ 'a': 'Alpha', 'b': 'Beta' });
	const head = snapshotFromNlsBundle({ 'a': 'Alpha', 'c': '[NEEDS_TRANSLATION] Charlie' });
	const meta = new Set(['a', 'b', 'c']);

	// 'b' is in base.translatedKeys but missing in head → regression → fail
	const r1 = decideI18nGate({ metadataKeys: meta, baseSnapshot: base, headSnapshot: head, coverageFloor: 0.95 });
	assert.equal(r1.verdict, 'fail');
	assert.ok(r1.regressedKeys.includes('b'));

	// No base → no regression check, only new-untranslated
	const r2 = decideI18nGate({ metadataKeys: meta, baseSnapshot: null, headSnapshot: head, coverageFloor: 0.0 });
	assert.equal(r2.verdict, 'warn');

	// All translated, above floor → ok
	const allGood = snapshotFromNlsBundle({ 'a': 'Alpha', 'b': 'Beta', 'c': 'Charlie' });
	const r3 = decideI18nGate({ metadataKeys: new Set(['a', 'b', 'c']), baseSnapshot: null, headSnapshot: allGood, coverageFloor: 0.95 });
	assert.equal(r3.verdict, 'ok');

	const report = describeI18nGate(r1, 'ru');
	assert.ok(report.includes('❌'));

	console.log('i18n-grace-period-policy.cjs: all self-tests passed');
}

module.exports = { decideI18nGate, describeI18nGate, snapshotFromNlsBundle };
