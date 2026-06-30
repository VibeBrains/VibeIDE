/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decodeLanguagePackContribution,
	buildLanguagePackLayout,
	buildLanguagePackAssetName,
	writeLanguagePackLayout,
	injectLanguagePackIntoProductJson,
	planLanguagePackRelease,
	LanguagePackNotImplementedError,
	type LanguagePackWriteIO,
} from '../../common/i18nLanguagePackBuilder.js';

suite('VibeIDE language-pack VSIX builder — shapes + IO orchestrator', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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
			if (r.ok) { assert.strictEqual(r.value.id, 'ru-by'); }
		});

		test('rejects malformed locale id', () => {
			const r = decodeLanguagePackContribution({
				id: 'not_a_locale!',
				localizedLanguageName: 'X',
				translations: [{ id: 'a', path: 'b' }],
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'id-invalid'); }
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
			if (!r.ok) { assert.strictEqual(r.reason, 'translations-empty'); }
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
			if (!r.ok) { assert.ok(r.reason.includes('duplicate-id')); }
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
			assert.ok(Object.hasOwn(r.mainBundles, 'parts/foo.i18n.json'));
			assert.ok(Object.hasOwn(r.extensionPackageBundles, 'vibeide-neon'));
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

		test('throws on malformed locale', () => {
			assert.throws(
				() => buildLanguagePackAssetName('!nope!', '1.0.0'),
				LanguagePackNotImplementedError,
			);
		});

		test('throws on missing version', () => {
			assert.throws(
				() => buildLanguagePackAssetName('ru', ''),
				LanguagePackNotImplementedError,
			);
		});
	});

	suite('writeLanguagePackLayout', () => {

		function makeStubIO(): { io: LanguagePackWriteIO; mkdirs: string[]; writes: Array<[string, string]> } {
			const mkdirs: string[] = [];
			const writes: Array<[string, string]> = [];
			const io: LanguagePackWriteIO = {
				mkdirRecursive: dir => { mkdirs.push(dir); },
				writeFileUtf8: (p, content) => { writes.push([p, content]); },
				joinPath: (...segments) => segments.filter(s => s.length > 0).join('/'),
			};
			return { io, mkdirs, writes };
		}

		test('writes main + extension bundles under <outDir>/<locale>/', () => {
			const layout = buildLanguagePackLayout({
				localeTag: 'ru',
				mainBundleEntries: [
					['parts/foo.i18n.json', new Map([['k', 'V']])],
				],
				extensionPackageEntries: [
					['vibeide-neon', new Map([['title', 'Тема']])],
				],
			});
			const { io, mkdirs, writes } = makeStubIO();
			const result = writeLanguagePackLayout(layout, '/out', io);

			assert.strictEqual(result.localeTag, 'ru');
			assert.ok(result.rootDir.startsWith('/out/ru'));
			assert.strictEqual(result.writtenFiles.length, 2);
			assert.ok(mkdirs.some(d => d.endsWith('/translations')));
			assert.ok(mkdirs.some(d => d.endsWith('/translations/main')));
			assert.ok(mkdirs.some(d => d.endsWith('/translations/extensions')));
			assert.ok(writes.some(([p]) => p.endsWith('foo.i18n.json')));
			assert.ok(writes.some(([p]) => p.endsWith('vibeide-neon/package.i18n.json')));
		});

		test('main bundle JSON keys are alphabetically sorted', () => {
			const layout = buildLanguagePackLayout({
				localeTag: 'ru',
				mainBundleEntries: [
					['a.i18n.json', new Map([['z', '1'], ['a', '2'], ['m', '3']])],
				],
				extensionPackageEntries: [],
			});
			const { io, writes } = makeStubIO();
			writeLanguagePackLayout(layout, '/out', io);
			const content = writes.find(([p]) => p.endsWith('a.i18n.json'))![1];
			const aIdx = content.indexOf('"a"');
			const mIdx = content.indexOf('"m"');
			const zIdx = content.indexOf('"z"');
			assert.ok(aIdx < mIdx && mIdx < zIdx, 'expected keys sorted ascending');
		});

		test('rejects invalid locale tag', () => {
			const layout = buildLanguagePackLayout({
				localeTag: 'ru',
				mainBundleEntries: [],
				extensionPackageEntries: [],
			});
			const { io } = makeStubIO();
			// Tamper with locale through cast — public path goes through buildLanguagePackLayout
			// which already normalises. So directly construct a malformed layout.
			const malformed = { ...layout, localeTag: '!nope!' };
			assert.throws(
				() => writeLanguagePackLayout(malformed as typeof layout, '/out', io),
				LanguagePackNotImplementedError,
			);
		});

		test('rejects empty outDir', () => {
			const layout = buildLanguagePackLayout({
				localeTag: 'ru',
				mainBundleEntries: [],
				extensionPackageEntries: [],
			});
			const { io } = makeStubIO();
			assert.throws(
				() => writeLanguagePackLayout(layout, '', io),
				LanguagePackNotImplementedError,
			);
		});
	});

	suite('injectLanguagePackIntoProductJson', () => {
		test('adds new entry and keeps existing entries', () => {
			const product = { builtInExtensions: [{ name: 'ms-vscode.other', version: '1.0.0', repo: 'https://x' }] };
			const next = injectLanguagePackIntoProductJson(product, {
				localeTag: 'ru',
				vibeVersion: '0.4.2',
				repo: 'https://github.com/borodatych/VibeIDE',
			});
			const ext = next.builtInExtensions as Array<{ name: string; version: string }>;
			assert.strictEqual(ext.length, 2);
			assert.ok(ext.some(e => e.name === 'vibeide-language-pack-ru' && e.version === '0.4.2'));
			assert.ok(ext.some(e => e.name === 'ms-vscode.other'));
		});

		test('replaces existing entry of same name', () => {
			const product = {
				builtInExtensions: [
					{ name: 'vibeide-language-pack-ru', version: '0.3.0', repo: 'old' },
				],
			};
			const next = injectLanguagePackIntoProductJson(product, {
				localeTag: 'ru',
				vibeVersion: '0.4.2',
				repo: 'new',
			});
			const ext = next.builtInExtensions as Array<{ name: string; version: string; repo: string }>;
			assert.strictEqual(ext.length, 1);
			assert.strictEqual(ext[0].version, '0.4.2');
			assert.strictEqual(ext[0].repo, 'new');
		});

		test('result is sorted by name', () => {
			const product = { builtInExtensions: [{ name: 'zz-extension', version: '1.0.0', repo: 'z' }] };
			const next = injectLanguagePackIntoProductJson(product, {
				localeTag: 'aa',
				vibeVersion: '1.0.0',
				repo: 'a',
			});
			const ext = next.builtInExtensions as Array<{ name: string }>;
			assert.strictEqual(ext[0].name, 'vibeide-language-pack-aa');
			assert.strictEqual(ext[1].name, 'zz-extension');
		});

		test('rejects invalid version', () => {
			assert.throws(
				() => injectLanguagePackIntoProductJson({}, { localeTag: 'ru', vibeVersion: 'banana', repo: 'r' }),
				LanguagePackNotImplementedError,
			);
		});

		test('rejects invalid locale', () => {
			assert.throws(
				() => injectLanguagePackIntoProductJson({}, { localeTag: '!nope!', vibeVersion: '1.0.0', repo: 'r' }),
				LanguagePackNotImplementedError,
			);
		});

		test('does not mutate input product.json', () => {
			const product = { builtInExtensions: [] };
			const next = injectLanguagePackIntoProductJson(product, {
				localeTag: 'ru',
				vibeVersion: '1.0.0',
				repo: 'r',
			});
			assert.notStrictEqual(next, product);
			assert.strictEqual((product.builtInExtensions as unknown[]).length, 0);
		});
	});

	suite('planLanguagePackRelease', () => {
		test('produces sorted, deduped asset list', () => {
			const plan = planLanguagePackRelease({
				vibeVersion: '0.4.2',
				locales: ['RU', 'en', 'ru', 'pt-br'],
			});
			assert.strictEqual(plan.vibeVersion, '0.4.2');
			assert.deepStrictEqual(
				plan.assets.map(a => a.localeTag),
				['en', 'pt-br', 'ru'],
			);
			assert.deepStrictEqual(
				plan.assets.map(a => a.assetName),
				[
					'vibeide-language-pack-en-0.4.2.vsix',
					'vibeide-language-pack-pt-br-0.4.2.vsix',
					'vibeide-language-pack-ru-0.4.2.vsix',
				],
			);
		});

		test('empty locales → empty assets', () => {
			const plan = planLanguagePackRelease({ vibeVersion: '1.0.0', locales: [] });
			assert.deepStrictEqual(plan.assets, []);
		});

		test('rejects invalid version', () => {
			assert.throws(
				() => planLanguagePackRelease({ vibeVersion: 'x', locales: [] }),
				LanguagePackNotImplementedError,
			);
		});

		test('rejects invalid locale', () => {
			assert.throws(
				() => planLanguagePackRelease({ vibeVersion: '1.0.0', locales: ['!nope!'] }),
				LanguagePackNotImplementedError,
			);
		});
	});
});
