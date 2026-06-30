/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	checkI18nRoundtrip,
	partitionLocaleForOrphanMove,
} from '../../common/i18nRoundtripChecker.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function meta(pairs: ReadonlyArray<readonly [string, string]>): Map<string, string> {
	return new Map(pairs);
}

function bundle(pairs: ReadonlyArray<readonly [string, string]>): Map<string, string> {
	return new Map(pairs);
}

suite('i18n round-trip checker — pure helper', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('checkI18nRoundtrip', () => {
		test('happy path → no issues', () => {
			const r = checkI18nRoundtrip({
				metadataEnglish: meta([['greet', 'Hello {0}']]),
				localeBundles: new Map([
					['ru', bundle([['greet', 'Привет {0}']])],
				]),
			});
			assert.deepStrictEqual(r.issues, []);
			assert.strictEqual(r.stats.totalIssues, 0);
		});

		test('orphan-key reported when translation key not in metadata', () => {
			const r = checkI18nRoundtrip({
				metadataEnglish: meta([['live', 'Live']]),
				localeBundles: new Map([
					['ru', bundle([['old.removed.key', 'устаревший']])],
				]),
			});
			assert.strictEqual(r.issues.length, 1);
			assert.strictEqual(r.issues[0].code, 'orphan-key');
			assert.strictEqual(r.issues[0].key, 'old.removed.key');
		});

		test('placeholder-count-mismatch', () => {
			const r = checkI18nRoundtrip({
				metadataEnglish: meta([['greet', 'Hello {0} from {1}']]),
				localeBundles: new Map([
					['ru', bundle([['greet', 'Привет {0}']])],
				]),
			});
			assert.strictEqual(r.issues.length, 1);
			assert.strictEqual(r.issues[0].code, 'placeholder-count-mismatch');
			assert.ok(r.issues[0].detail && r.issues[0].detail.includes('english=2'));
			assert.ok(r.issues[0].detail!.includes('translation=1'));
		});

		test('empty translation reported', () => {
			const r = checkI18nRoundtrip({
				metadataEnglish: meta([['greet', 'Hello']]),
				localeBundles: new Map([
					['ru', bundle([['greet', '']])],
				]),
			});
			assert.strictEqual(r.issues.length, 1);
			assert.strictEqual(r.issues[0].code, 'empty-translation');
		});

		test('[NEEDS_TRANSLATION] is NOT a placeholder mismatch (skipped)', () => {
			const r = checkI18nRoundtrip({
				metadataEnglish: meta([['greet', 'Hello {0}']]),
				localeBundles: new Map([
					['ru', bundle([['greet', '[NEEDS_TRANSLATION] Hello {0}']])],
				]),
			});
			assert.strictEqual(r.issues.length, 0);
		});

		test('keys missing from locale → NOT reported (coverage is i18nGracePeriodPolicy job)', () => {
			const r = checkI18nRoundtrip({
				metadataEnglish: meta([['a', 'A'], ['b', 'B']]),
				localeBundles: new Map([
					['ru', bundle([['a', 'А']])], // missing 'b' — that's coverage gate's problem
				]),
			});
			assert.strictEqual(r.issues.length, 0);
		});

		test('multiple locales reported deterministically', () => {
			const r = checkI18nRoundtrip({
				metadataEnglish: meta([['greet', 'Hello {0}']]),
				localeBundles: new Map([
					['ru', bundle([['greet', 'Привет']])],
					['de', bundle([['greet', 'Hallo']])],
				]),
			});
			assert.strictEqual(r.issues.length, 2);
			// sorted: de before ru
			assert.strictEqual(r.issues[0].localeTag, 'de');
			assert.strictEqual(r.issues[1].localeTag, 'ru');
		});

		test('per-locale stats counted', () => {
			const r = checkI18nRoundtrip({
				metadataEnglish: meta([['a', 'A {0}'], ['b', 'B']]),
				localeBundles: new Map([
					['ru', bundle([['a', 'А {0}'], ['b', 'Б']])],
					['de', bundle([['a', 'A'], ['b', '']])],
				]),
			});
			assert.strictEqual(r.stats.totalLocales, 2);
			assert.strictEqual(r.stats.perLocale['ru'], 0);
			assert.strictEqual(r.stats.perLocale['de'], 2);
		});

		test('keys sorted within locale for stable diff', () => {
			const r = checkI18nRoundtrip({
				metadataEnglish: meta([['a', 'A']]),
				localeBundles: new Map([
					['ru', bundle([['z', 'З'], ['a', 'А'], ['m', 'М']])],
				]),
			});
			// Two orphans (z, m) reported in sorted order
			assert.strictEqual(r.issues[0].key, 'm');
			assert.strictEqual(r.issues[1].key, 'z');
		});

		test('empty inputs → no issues', () => {
			const r = checkI18nRoundtrip({
				metadataEnglish: new Map(),
				localeBundles: new Map(),
			});
			assert.deepStrictEqual(r.issues, []);
			assert.strictEqual(r.stats.totalLocales, 0);
		});
	});

	suite('partitionLocaleForOrphanMove', () => {
		test('happy partition', () => {
			const r = partitionLocaleForOrphanMove(
				bundle([['live', 'жив'], ['old', 'старо']]),
				new Set(['live']),
			);
			assert.deepStrictEqual([...r.keep], [['live', 'жив']]);
			assert.deepStrictEqual([...r.orphan], [['old', 'старо']]);
		});

		test('all-keep when every key in metadata', () => {
			const r = partitionLocaleForOrphanMove(
				bundle([['a', 'А'], ['b', 'Б']]),
				new Set(['a', 'b']),
			);
			assert.strictEqual(r.orphan.size, 0);
			assert.strictEqual(r.keep.size, 2);
		});

		test('all-orphan when bundle keys all gone', () => {
			const r = partitionLocaleForOrphanMove(
				bundle([['a', 'А'], ['b', 'Б']]),
				new Set(),
			);
			assert.strictEqual(r.keep.size, 0);
			assert.strictEqual(r.orphan.size, 2);
		});
	});
});
