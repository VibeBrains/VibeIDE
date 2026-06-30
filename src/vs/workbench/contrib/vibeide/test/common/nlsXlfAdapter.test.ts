/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decodeXlfFile,
	buildXlfFile,
	extractTranslationsFromXlf,
	diffXlfFiles,
	XlfFile,
} from '../../common/nlsXlfAdapter.js';

const valid = (overrides: Record<string, unknown> = {}): unknown => ({
	sourceLocale: 'en',
	targetLocale: 'ru',
	bundleName: 'vibeide.nls',
	transUnits: [{ key: 'app.title', source: 'VibeIDE' }],
	...overrides,
});

suite('VS Code NLS XLF adapter — typed contract', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeXlfFile', () => {
		test('happy path', () => {
			const r = decodeXlfFile(valid());
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.sourceLocale, 'en');
				assert.strictEqual(r.value.targetLocale, 'ru');
				assert.strictEqual(r.value.transUnits.length, 1);
			}
		});

		test('rejects malformed sourceLocale', () => {
			const r = decodeXlfFile(valid({ sourceLocale: 'not_a_locale!' }));
			assert.strictEqual(r.ok, false);
		});

		test('rejects empty bundleName', () => {
			const r = decodeXlfFile(valid({ bundleName: '' }));
			assert.strictEqual(r.ok, false);
		});

		test('rejects duplicate keys', () => {
			const r = decodeXlfFile(valid({
				transUnits: [
					{ key: 'a', source: 'A' },
					{ key: 'a', source: 'A2' },
				],
			}));
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.reason.includes('duplicate-key')); }
		});

		test('rejects malformed key pattern', () => {
			const r = decodeXlfFile(valid({
				transUnits: [{ key: 'has space', source: 'X' }],
			}));
			assert.strictEqual(r.ok, false);
		});

		test('locale lowercased', () => {
			const r = decodeXlfFile(valid({ sourceLocale: 'EN', targetLocale: 'RU' }));
			if (r.ok) {
				assert.strictEqual(r.value.sourceLocale, 'en');
				assert.strictEqual(r.value.targetLocale, 'ru');
			}
		});

		test('target field optional', () => {
			const r = decodeXlfFile(valid({
				transUnits: [{ key: 'a', source: 'A', target: 'А' }],
			}));
			if (r.ok) { assert.strictEqual(r.value.transUnits[0].target, 'А'); }
		});

		test('note field passed through', () => {
			const r = decodeXlfFile(valid({
				transUnits: [{ key: 'a', source: 'A', note: 'context hint' }],
			}));
			if (r.ok) { assert.strictEqual(r.value.transUnits[0].note, 'context hint'); }
		});

		test('rejects null root', () => {
			assert.strictEqual(decodeXlfFile(null).ok, false);
		});

		test('rejects non-string source', () => {
			const r = decodeXlfFile(valid({
				transUnits: [{ key: 'a', source: 42 }],
			}));
			assert.strictEqual(r.ok, false);
		});
	});

	suite('buildXlfFile', () => {
		test('happy path with translations', () => {
			const r = buildXlfFile({
				sourceLocale: 'en',
				targetLocale: 'ru',
				bundleName: 'vibeide.nls',
				metadataEnglish: new Map([['a', 'A'], ['b', 'B']]),
				translations: new Map([['a', 'А']]),
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.transUnits.length, 2);
				assert.strictEqual(r.value.transUnits[0].target, 'А');
				assert.strictEqual(r.value.transUnits[1].target, undefined);
			}
		});

		test('rejects source==target', () => {
			const r = buildXlfFile({
				sourceLocale: 'en',
				targetLocale: 'en',
				bundleName: 'x',
				metadataEnglish: new Map(),
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'source-and-target-equal'); }
		});

		test('keys sorted in output', () => {
			const r = buildXlfFile({
				sourceLocale: 'en',
				targetLocale: 'ru',
				bundleName: 'x',
				metadataEnglish: new Map([['z', 'Z'], ['a', 'A'], ['m', 'M']]),
			});
			if (r.ok) {
				assert.deepStrictEqual(r.value.transUnits.map(u => u.key), ['a', 'm', 'z']);
			}
		});

		test('drops malformed keys silently', () => {
			const r = buildXlfFile({
				sourceLocale: 'en',
				targetLocale: 'ru',
				bundleName: 'x',
				metadataEnglish: new Map([['ok', 'O'], ['bad space', 'X']]),
			});
			if (r.ok) {
				assert.deepStrictEqual(r.value.transUnits.map(u => u.key), ['ok']);
			}
		});

		test('empty translations omits target', () => {
			const r = buildXlfFile({
				sourceLocale: 'en',
				targetLocale: 'ru',
				bundleName: 'x',
				metadataEnglish: new Map([['a', 'A']]),
				translations: new Map([['a', '']]),
			});
			if (r.ok) { assert.strictEqual(r.value.transUnits[0].target, undefined); }
		});
	});

	suite('extractTranslationsFromXlf', () => {
		test('returns key→target map', () => {
			const file: XlfFile = {
				sourceLocale: 'en',
				targetLocale: 'ru',
				bundleName: 'x',
				transUnits: [
					{ key: 'a', source: 'A', target: 'А' },
					{ key: 'b', source: 'B' },
					{ key: 'c', source: 'C', target: 'С' },
				],
			};
			const r = extractTranslationsFromXlf(file);
			assert.strictEqual(r.size, 2);
			assert.strictEqual(r.get('a'), 'А');
			assert.strictEqual(r.get('c'), 'С');
		});

		test('untranslated keys dropped', () => {
			const file: XlfFile = {
				sourceLocale: 'en',
				targetLocale: 'ru',
				bundleName: 'x',
				transUnits: [{ key: 'a', source: 'A' }],
			};
			assert.strictEqual(extractTranslationsFromXlf(file).size, 0);
		});

		test('empty target dropped', () => {
			const file: XlfFile = {
				sourceLocale: 'en',
				targetLocale: 'ru',
				bundleName: 'x',
				transUnits: [{ key: 'a', source: 'A', target: '' }],
			};
			assert.strictEqual(extractTranslationsFromXlf(file).size, 0);
		});
	});

	suite('diffXlfFiles', () => {
		const base: XlfFile = {
			sourceLocale: 'en',
			targetLocale: 'ru',
			bundleName: 'x',
			transUnits: [
				{ key: 'a', source: 'A', target: 'А' },
				{ key: 'b', source: 'B' },
			],
		};

		test('detects added key', () => {
			const next: XlfFile = {
				...base,
				transUnits: [...base.transUnits, { key: 'c', source: 'C' }],
			};
			const r = diffXlfFiles(base, next);
			assert.deepStrictEqual([...r.added], ['c']);
		});

		test('detects modified source', () => {
			const next: XlfFile = {
				...base,
				transUnits: [
					{ key: 'a', source: 'A-new', target: 'А' },
					base.transUnits[1],
				],
			};
			const r = diffXlfFiles(base, next);
			assert.deepStrictEqual([...r.modified], ['a']);
		});

		test('detects modified target', () => {
			const next: XlfFile = {
				...base,
				transUnits: [
					{ key: 'a', source: 'A', target: 'А-новое' },
					base.transUnits[1],
				],
			};
			const r = diffXlfFiles(base, next);
			assert.deepStrictEqual([...r.modified], ['a']);
		});

		test('detects removed', () => {
			const next: XlfFile = {
				...base,
				transUnits: [base.transUnits[0]],
			};
			const r = diffXlfFiles(base, next);
			assert.deepStrictEqual([...r.removed], ['b']);
		});

		test('localeChanged flag', () => {
			const next: XlfFile = { ...base, targetLocale: 'de' };
			const r = diffXlfFiles(base, next);
			assert.strictEqual(r.localeChanged, true);
		});

		test('all empty when identical', () => {
			const r = diffXlfFiles(base, base);
			assert.deepStrictEqual([...r.added], []);
			assert.deepStrictEqual([...r.modified], []);
			assert.deepStrictEqual([...r.removed], []);
			assert.strictEqual(r.localeChanged, false);
		});

		test('output sorted', () => {
			const next: XlfFile = {
				...base,
				transUnits: [
					...base.transUnits,
					{ key: 'z', source: 'Z' },
					{ key: 'a-new', source: 'AA' },
				],
			};
			const r = diffXlfFiles(base, next);
			assert.deepStrictEqual([...r.added], ['a-new', 'z']);
		});
	});
});
