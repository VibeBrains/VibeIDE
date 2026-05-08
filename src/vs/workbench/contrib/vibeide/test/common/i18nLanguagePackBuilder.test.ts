/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	decodeLanguagePackContribution,
	buildLanguagePackLayout,
	buildLanguagePackAssetName,
	LanguagePackNotImplementedError,
	extractVibeideLocaleStrings,
	buildVibeideLanguagePacks,
	buildLanguagePackForRelease,
} from '../../common/i18nLanguagePackBuilder.js';

suite('VibeIDE language-pack VSIX builder — shapes + sentinels', () => {

	suite('decodeLanguagePackContribution', () => {
		test('happy path', () => {
			const r = decodeLanguagePackContribution({
				id: 'ru',
				localizedLanguageName: 'Русский',
				translations: [{ id: 'vscode', path: './translations/main.i18n.json' }],
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.id, 'ru');
				assert.strictEqual(r.value.translations.length, 1);
			}
		});

		test('id case-normalised to lowercase', () => {
			const r = decodeLanguagePackContribution({
				id: 'RU-by',
				localizedLanguageName: 'Беларуская',
				translations: [{ id: 'vscode', path: './x' }],
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) assert.strictEqual(r.value.id, 'ru-by');
		});

		test('rejects malformed locale id', () => {
			const r = decodeLanguagePackContribution({
				id: 'not_a_locale!',
				localizedLanguageName: 'X',
				translations: [{ id: 'a', path: 'b' }],
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) assert.strictEqual(r.reason, 'id-invalid');
		});

		test('rejects empty localizedLanguageName', () => {
			const r = decodeLanguagePackContribution({
				id: 'ru',
				localizedLanguageName: '',
				translations: [{ id: 'a', path: 'b' }],
			});
			assert.strictEqual(r.ok, false);
		});

		test('rejects empty translations', () => {
			const r = decodeLanguagePackContribution({
				id: 'ru',
				localizedLanguageName: 'Русский',
				translations: [],
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) assert.strictEqual(r.reason, 'translations-empty');
		});

		test('rejects duplicate translation id', () => {
			const r = decodeLanguagePackContribution({
				id: 'ru',
				localizedLanguageName: 'Русский',
				translations: [
					{ id: 'vscode', path: 'a' },
					{ id: 'vscode', path: 'b' },
				],
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) assert.ok(r.reason.includes('duplicate-id'));
		});

		test('rejects null root', () => {
			assert.strictEqual(decodeLanguagePackContribution(null).ok, false);
		});

		test('rejects translation with empty id or path', () => {
			const r1 = decodeLanguagePackContribution({
				id: 'ru', localizedLanguageName: 'X',
				translations: [{ id: '', path: 'b' }],
			});
			assert.strictEqual(r1.ok, false);
			const r2 = decodeLanguagePackContribution({
				id: 'ru', localizedLanguageName: 'X',
				translations: [{ id: 'a', path: '' }],
			});
			assert.strictEqual(r2.ok, false);
		});
	});

	suite('buildLanguagePackLayout', () => {
		test('canonicalises locale tag and forwards bundles', () => {
			const r = buildLanguagePackLayout({
				localeTag: '  RU-BY  ',
				mainBundleEntries: [['parts/foo.i18n.json', new Map([['k', 'V']])]],
				extensionPackageEntries: [['vibeide-neon', new Map([['title', 'Тема']])]],
			});
			assert.strictEqual(r.localeTag, 'ru-by');
			assert.ok('parts/foo.i18n.json' in r.mainBundles);
			assert.ok('vibeide-neon' in r.extensionPackageBundles);
		});

		test('empty inputs accepted', () => {
			const r = buildLanguagePackLayout({
				localeTag: 'ru',
				mainBundleEntries: [],
				extensionPackageEntries: [],
			});
			assert.deepStrictEqual(Object.keys(r.mainBundles), []);
		});
	});

	suite('buildLanguagePackAssetName', () => {
		test('happy path', () => {
			assert.strictEqual(
				buildLanguagePackAssetName('ru', '1.2.3'),
				'vibeide-language-pack-ru-1.2.3.vsix',
			);
		});

		test('case-normalised, trimmed', () => {
			assert.strictEqual(
				buildLanguagePackAssetName('  RU-BY  ', '  2.0.0  '),
				'vibeide-language-pack-ru-by-2.0.0.vsix',
			);
		});

		test('throws sentinel on malformed locale', () => {
			assert.throws(
				() => buildLanguagePackAssetName('!nope!', '1.0.0'),
				LanguagePackNotImplementedError,
			);
		});

		test('throws sentinel on missing version', () => {
			assert.throws(
				() => buildLanguagePackAssetName('ru', ''),
				LanguagePackNotImplementedError,
			);
		});
	});

	suite('sentinel skeleton stubs', () => {
		test('extractVibeideLocaleStrings throws sentinel', () => {
			assert.throws(
				() => extractVibeideLocaleStrings({ srcRoot: '.', outFile: 'x.json' }),
				LanguagePackNotImplementedError,
			);
		});

		test('buildVibeideLanguagePacks throws sentinel', () => {
			assert.throws(
				() => buildVibeideLanguagePacks({ metadataPath: '.', localesDir: '.', outDir: '.' }),
				LanguagePackNotImplementedError,
			);
		});

		test('buildLanguagePackForRelease throws sentinel', () => {
			assert.throws(
				() => buildLanguagePackForRelease({ vibeVersion: '1.0.0', locales: ['ru'] }),
				LanguagePackNotImplementedError,
			);
		});

		test('sentinel error message references roadmap section', () => {
			let captured: unknown;
			try {
				extractVibeideLocaleStrings({ srcRoot: '.', outFile: 'x' });
			} catch (e) {
				captured = e;
			}
			assert.ok(captured instanceof LanguagePackNotImplementedError);
			const msg = (captured as Error).message;
			assert.ok(msg.includes('roadmap'));
			assert.ok(msg.includes('Pack VSIX'));
		});
	});
});
