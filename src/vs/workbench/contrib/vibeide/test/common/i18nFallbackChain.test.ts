/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	resolveLocalized,
	baseLocaleOf,
	normaliseLocale,
	LocaleBundle,
} from '../../common/i18nFallbackChain.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function bundle(tag: string, entries: ReadonlyArray<readonly [string, string]>): LocaleBundle {
	return { localeTag: tag, entries: new Map(entries) };
}

suite('i18n fallback chain — pure resolver', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('normaliseLocale', () => {
		test('lowercase + dash + trim', () => {
			assert.strictEqual(normaliseLocale('  ru-BY  '), 'ru-by');
			assert.strictEqual(normaliseLocale('PT_BR'), 'pt-br');
			assert.strictEqual(normaliseLocale('en'), 'en');
		});
		test('non-string → empty', () => {
			assert.strictEqual(normaliseLocale(undefined as unknown as string), '');
			assert.strictEqual(normaliseLocale(42 as unknown as string), '');
		});
	});

	suite('baseLocaleOf', () => {
		test('ru-by → ru', () => {
			assert.strictEqual(baseLocaleOf('ru-by'), 'ru');
			assert.strictEqual(baseLocaleOf('pt-BR'), 'pt');
		});
		test('flat locale → null', () => {
			assert.strictEqual(baseLocaleOf('ru'), null);
			assert.strictEqual(baseLocaleOf('en'), null);
		});
		test('underscore form normalised', () => {
			assert.strictEqual(baseLocaleOf('ru_by'), 'ru');
		});
		test('empty → null', () => {
			assert.strictEqual(baseLocaleOf(''), null);
		});
	});

	suite('resolveLocalized chain', () => {
		test('requested-locale exact match wins', () => {
			const r = resolveLocalized({
				key: 'app.title',
				englishDefault: 'VibeIDE',
				requestedLocale: 'ru',
				bundles: [bundle('ru', [['app.title', 'ВайбИДЕ']])],
			});
			assert.deepStrictEqual(r, { value: 'ВайбИДЕ', source: 'requested-locale' });
		});

		test('base-locale fallback (ru-by → ru)', () => {
			const r = resolveLocalized({
				key: 'app.title',
				englishDefault: 'VibeIDE',
				requestedLocale: 'ru-by',
				bundles: [bundle('ru', [['app.title', 'ВайбИДЕ']])],
			});
			assert.deepStrictEqual(r, { value: 'ВайбИДЕ', source: 'base-locale' });
		});

		test('english-default fallback when no bundle', () => {
			const r = resolveLocalized({
				key: 'app.title',
				englishDefault: 'VibeIDE',
				requestedLocale: 'fr',
				bundles: [],
			});
			assert.deepStrictEqual(r, { value: 'VibeIDE', source: 'english-default' });
		});

		test('key fallback when no englishDefault either', () => {
			const r = resolveLocalized({
				key: 'app.title',
				requestedLocale: 'fr',
				bundles: [],
			});
			assert.deepStrictEqual(r, { value: 'app.title', source: 'key' });
		});

		test('empty translation in bundle → next fallback', () => {
			const r = resolveLocalized({
				key: 'app.title',
				englishDefault: 'VibeIDE',
				requestedLocale: 'ru',
				bundles: [bundle('ru', [['app.title', '']])],
			});
			assert.deepStrictEqual(r, { value: 'VibeIDE', source: 'english-default' });
		});

		test('[NEEDS_TRANSLATION] marker → next fallback (never shown to user)', () => {
			const r = resolveLocalized({
				key: 'app.title',
				englishDefault: 'VibeIDE',
				requestedLocale: 'ru',
				bundles: [bundle('ru', [['app.title', '[NEEDS_TRANSLATION] VibeIDE']])],
			});
			assert.deepStrictEqual(r, { value: 'VibeIDE', source: 'english-default' });
		});

		test('base-locale used only when exact missing', () => {
			const r = resolveLocalized({
				key: 'app.title',
				englishDefault: 'VibeIDE',
				requestedLocale: 'ru-by',
				bundles: [
					bundle('ru-by', [['app.title', 'ВайбIDE-by']]),
					bundle('ru', [['app.title', 'ВайбИДЕ']]),
				],
			});
			assert.strictEqual(r.source, 'requested-locale');
			assert.strictEqual(r.value, 'ВайбIDE-by');
		});

		test('case-insensitive match: bundle "RU-BY" matches "ru-by"', () => {
			const r = resolveLocalized({
				key: 'app.title',
				englishDefault: 'VibeIDE',
				requestedLocale: 'ru-by',
				bundles: [bundle('RU-BY', [['app.title', 'ВайбIDE-by']])],
			});
			assert.strictEqual(r.source, 'requested-locale');
		});

		test('empty englishDefault is skipped (key fallback)', () => {
			const r = resolveLocalized({
				key: 'app.title',
				englishDefault: '',
				requestedLocale: 'fr',
				bundles: [],
			});
			assert.deepStrictEqual(r, { value: 'app.title', source: 'key' });
		});

		test('empty requestedLocale → english-default directly', () => {
			const r = resolveLocalized({
				key: 'app.title',
				englishDefault: 'VibeIDE',
				requestedLocale: '',
				bundles: [],
			});
			assert.deepStrictEqual(r, { value: 'VibeIDE', source: 'english-default' });
		});

		test('missing key in present bundle → next fallback', () => {
			const r = resolveLocalized({
				key: 'app.title',
				englishDefault: 'VibeIDE',
				requestedLocale: 'ru',
				bundles: [bundle('ru', [['other', 'другое']])],
			});
			assert.strictEqual(r.source, 'english-default');
		});
	});
});
