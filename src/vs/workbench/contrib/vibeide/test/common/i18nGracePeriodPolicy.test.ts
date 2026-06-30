/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decideI18nGate,
	findKeysNeedingPlaceholder,
	describeI18nGate,
	I18nLocaleSnapshot,
} from '../../common/i18nGracePeriodPolicy.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function snapshot(translated: readonly string[], needs: readonly string[] = []): I18nLocaleSnapshot {
	return {
		translatedKeys: new Set(translated),
		needsTranslationKeys: new Set(needs),
	};
}

suite('i18n CI gate — grace-period policy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideI18nGate', () => {
		test('all translated → ok, 100%', () => {
			const r = decideI18nGate({
				metadataKeys: new Set(['a', 'b', 'c']),
				baseSnapshot: snapshot(['a', 'b', 'c']),
				headSnapshot: snapshot(['a', 'b', 'c']),
				coverageFloor: 0.95,
			});
			assert.strictEqual(r.verdict, 'ok');
			assert.strictEqual(r.coverage, 1);
			assert.deepStrictEqual(r.regressedKeys, []);
		});

		test('regressed key (was translated, now gone) → FAIL', () => {
			const r = decideI18nGate({
				metadataKeys: new Set(['a', 'b']),
				baseSnapshot: snapshot(['a', 'b']),
				headSnapshot: snapshot(['a']),
				coverageFloor: 0.95,
			});
			assert.strictEqual(r.verdict, 'fail');
			assert.deepStrictEqual(r.regressedKeys, ['b']);
		});

		test('new untranslated key only → WARN (not fail)', () => {
			const r = decideI18nGate({
				metadataKeys: new Set(['a', 'b', 'c']),
				baseSnapshot: snapshot(['a', 'b']),
				headSnapshot: snapshot(['a', 'b']),
				coverageFloor: 0.95,
			});
			assert.strictEqual(r.verdict, 'warn');
			assert.deepStrictEqual(r.newUntranslatedKeys, ['c']);
			assert.deepStrictEqual(r.regressedKeys, []);
		});

		test('new untranslated + below floor → still WARN (not fail)', () => {
			// 1 translated of 5 keys → 20% coverage
			const r = decideI18nGate({
				metadataKeys: new Set(['a', 'b', 'c', 'd', 'e']),
				baseSnapshot: snapshot(['a']),
				headSnapshot: snapshot(['a']),
				coverageFloor: 0.95,
			});
			assert.strictEqual(r.verdict, 'warn');
			assert.ok(r.reasons.some(s => s.startsWith('below-floor:')));
		});

		test('regression PLUS below floor → FAIL', () => {
			const r = decideI18nGate({
				metadataKeys: new Set(['a', 'b', 'c']),
				baseSnapshot: snapshot(['a', 'b', 'c']),
				headSnapshot: snapshot(['a']),
				coverageFloor: 0.95,
			});
			assert.strictEqual(r.verdict, 'fail');
			assert.deepStrictEqual(r.regressedKeys, ['b', 'c']);
		});

		test('removed-from-metadata is not a regression (key was deleted, not lost)', () => {
			const r = decideI18nGate({
				metadataKeys: new Set(['a']),       // 'b' removed
				baseSnapshot: snapshot(['a', 'b']),
				headSnapshot: snapshot(['a']),       // 'b' translation also gone — but key gone too
				coverageFloor: 0.95,
			});
			assert.strictEqual(r.verdict, 'ok');
			assert.deepStrictEqual(r.regressedKeys, []);
		});

		test('null baseSnapshot → no regressed list, only new/coverage', () => {
			const r = decideI18nGate({
				metadataKeys: new Set(['a', 'b']),
				baseSnapshot: null,
				headSnapshot: snapshot(['a']),
				coverageFloor: 0.95,
			});
			assert.strictEqual(r.verdict, 'warn');
			assert.deepStrictEqual(r.regressedKeys, []);
			assert.deepStrictEqual(r.newUntranslatedKeys, ['b']);
		});

		test('empty metadata → 100% coverage by definition', () => {
			const r = decideI18nGate({
				metadataKeys: new Set<string>(),
				baseSnapshot: snapshot([]),
				headSnapshot: snapshot([]),
				coverageFloor: 0.95,
			});
			assert.strictEqual(r.verdict, 'ok');
			assert.strictEqual(r.coverage, 1);
		});

		test('coverage exactly at floor → ok (no warn for boundary)', () => {
			// 19 of 20 → 95.0%
			const meta = new Set(Array.from({ length: 20 }, (_, i) => `k${i}`));
			const head = new Set(Array.from({ length: 19 }, (_, i) => `k${i}`));
			const r = decideI18nGate({
				metadataKeys: meta,
				baseSnapshot: snapshot([...head]),
				headSnapshot: snapshot([...head]),
				coverageFloor: 0.95,
			});
			// new untranslated 'k19' triggers warn, but coverage itself is at floor (not below)
			assert.strictEqual(r.verdict, 'warn');
			assert.ok(!r.reasons.some(s => s.startsWith('below-floor:')));
		});

		test('regressedKeys sorted deterministically', () => {
			const r = decideI18nGate({
				metadataKeys: new Set(['z', 'a', 'm']),
				baseSnapshot: snapshot(['z', 'a', 'm']),
				headSnapshot: snapshot([]),
				coverageFloor: 0.95,
			});
			assert.deepStrictEqual(r.regressedKeys, ['a', 'm', 'z']);
		});

		test('newUntranslatedKeys sorted deterministically', () => {
			const r = decideI18nGate({
				metadataKeys: new Set(['z', 'a', 'm']),
				baseSnapshot: snapshot([]),
				headSnapshot: snapshot([]),
				coverageFloor: 0.95,
			});
			assert.deepStrictEqual(r.newUntranslatedKeys, ['a', 'm', 'z']);
		});
	});

	suite('findKeysNeedingPlaceholder', () => {
		test('returns metadata keys absent from both translated and needs-translation', () => {
			const r = findKeysNeedingPlaceholder(
				new Set(['a', 'b', 'c', 'd']),
				snapshot(['a'], ['b']),
			);
			assert.deepStrictEqual(r, ['c', 'd']);
		});

		test('returns empty when all keys are tracked one way or another', () => {
			const r = findKeysNeedingPlaceholder(
				new Set(['a', 'b']),
				snapshot(['a'], ['b']),
			);
			assert.deepStrictEqual(r, []);
		});
	});

	suite('describeI18nGate', () => {
		test('ok body has green checkmark and percentage', () => {
			const dec = decideI18nGate({
				metadataKeys: new Set(['a']),
				baseSnapshot: snapshot(['a']),
				headSnapshot: snapshot(['a']),
				coverageFloor: 0.95,
			});
			const body = describeI18nGate(dec, 'ru');
			assert.ok(body.includes('100.0%'));
			assert.ok(body.includes('✅'));
		});

		test('warn body lists new untranslated', () => {
			const dec = decideI18nGate({
				metadataKeys: new Set(['a', 'b']),
				baseSnapshot: snapshot(['a']),
				headSnapshot: snapshot(['a']),
				coverageFloor: 0.95,
			});
			const body = describeI18nGate(dec, 'ru');
			assert.ok(body.includes('⚠️'));
			assert.ok(body.includes('Новые непереведённые'));
			assert.ok(body.includes('`b`'));
		});

		test('fail body lists regressed keys with FAIL header', () => {
			const dec = decideI18nGate({
				metadataKeys: new Set(['a']),
				baseSnapshot: snapshot(['a']),
				headSnapshot: snapshot([]),
				coverageFloor: 0.95,
			});
			const body = describeI18nGate(dec, 'ru');
			assert.ok(body.includes('❌'));
			assert.ok(body.includes('Регрессии'));
			assert.ok(body.includes('`a`'));
		});

		test('truncates after 20 keys with «…и ещё N»', () => {
			const meta: string[] = [];
			for (let i = 0; i < 25; i++) { meta.push(`k${String(i).padStart(2, '0')}`); }
			const dec = decideI18nGate({
				metadataKeys: new Set(meta),
				baseSnapshot: snapshot([]),
				headSnapshot: snapshot([]),
				coverageFloor: 0.95,
			});
			const body = describeI18nGate(dec, 'ru');
			assert.ok(body.includes('…и ещё 5'));
		});
	});
});
