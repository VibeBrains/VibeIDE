/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildMetadataContextEntry,
	buildMetadataIndex,
} from '../../common/i18nMetadataContext.js';

suite('i18n metadata source-context attacher — pure helper', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildMetadataContextEntry', () => {
		test('happy path with source + snippet + screenshot', () => {
			const r = buildMetadataContextEntry({
				key: 'app.title',
				englishSource: 'VibeIDE',
				sourceContext: {
					filePath: 'src/foo.ts',
					lineNumber: 42,
					snippet: 'export const t = localize("app.title", "VibeIDE");',
				},
				screenshots: [{ screenName: 'welcome', path: 'tests/screens/welcome.png' }],
			});
			assert.strictEqual(r.english, 'VibeIDE');
			assert.ok(r.context.startsWith('src/foo.ts:42'));
			assert.ok(r.context.includes('localize("app.title"'));
			assert.ok(r.context.includes('Screenshots: welcome'));
		});

		test('only english (no context, no screenshots) → empty context', () => {
			const r = buildMetadataContextEntry({ key: 'k', englishSource: 'V' });
			assert.strictEqual(r.context, '');
		});

		test('snippet clipped to 3 lines', () => {
			const r = buildMetadataContextEntry({
				key: 'k', englishSource: 'V',
				sourceContext: { filePath: 'a.ts', lineNumber: 1, snippet: 'a\nb\nc\nd\ne' },
			});
			const lines = r.context.split('\n');
			// header + max 3 snippet lines = 4
			assert.strictEqual(lines.length, 4);
			assert.deepStrictEqual(lines.slice(1), ['a', 'b', 'c']);
		});

		test('CRLF normalised to LF', () => {
			const r = buildMetadataContextEntry({
				key: 'k', englishSource: 'V',
				sourceContext: { filePath: 'a.ts', lineNumber: 1, snippet: 'a\r\nb\r\nc' },
			});
			assert.ok(!r.context.includes('\r'));
		});

		test('lines clipped to 200 chars with ellipsis', () => {
			const longLine = 'x'.repeat(250);
			const r = buildMetadataContextEntry({
				key: 'k', englishSource: 'V',
				sourceContext: { filePath: 'a.ts', lineNumber: 1, snippet: longLine },
			});
			const lines = r.context.split('\n');
			assert.ok(lines[1].length === 201);
			assert.ok(lines[1].endsWith('…'));
		});

		test('leading and trailing empty lines dropped', () => {
			const r = buildMetadataContextEntry({
				key: 'k', englishSource: 'V',
				sourceContext: { filePath: 'a.ts', lineNumber: 1, snippet: '\n\nactual\n\n' },
			});
			const lines = r.context.split('\n');
			assert.deepStrictEqual(lines.slice(1), ['actual']);
		});

		test('screenshots de-duplicated by name', () => {
			const r = buildMetadataContextEntry({
				key: 'k', englishSource: 'V',
				screenshots: [
					{ screenName: 'welcome', path: 'a.png' },
					{ screenName: 'welcome', path: 'b.png' },
					{ screenName: 'sidebar', path: 'c.png' },
				],
			});
			assert.ok(r.context.includes('Screenshots: welcome, sidebar'));
		});

		test('empty screenshot names dropped', () => {
			const r = buildMetadataContextEntry({
				key: 'k', englishSource: 'V',
				screenshots: [{ screenName: '   ', path: 'a.png' }],
			});
			assert.strictEqual(r.context, '');
		});

		test('non-finite lineNumber → file path only header', () => {
			const r = buildMetadataContextEntry({
				key: 'k', englishSource: 'V',
				sourceContext: { filePath: 'a.ts', lineNumber: NaN, snippet: 'x' },
			});
			assert.strictEqual(r.context.split('\n')[0], 'a.ts');
		});

		test('zero / negative lineNumber rejected → file path only', () => {
			const r = buildMetadataContextEntry({
				key: 'k', englishSource: 'V',
				sourceContext: { filePath: 'a.ts', lineNumber: 0, snippet: 'x' },
			});
			assert.strictEqual(r.context.split('\n')[0], 'a.ts');
		});

		test('empty filePath → no header line', () => {
			const r = buildMetadataContextEntry({
				key: 'k', englishSource: 'V',
				sourceContext: { filePath: '   ', lineNumber: 1, snippet: 'x' },
			});
			assert.strictEqual(r.context, 'x');
		});
	});

	suite('buildMetadataIndex (bulk)', () => {
		test('preserves insertion order', () => {
			const r = buildMetadataIndex([
				{ key: 'b', englishSource: 'B' },
				{ key: 'a', englishSource: 'A' },
			]);
			assert.deepStrictEqual([...r.keys()], ['b', 'a']);
		});

		test('drops rows with empty key', () => {
			const r = buildMetadataIndex([
				{ key: '', englishSource: 'X' },
				{ key: 'a', englishSource: 'A' },
			]);
			assert.deepStrictEqual([...r.keys()], ['a']);
		});

		test('non-string key dropped', () => {
			const r = buildMetadataIndex([
				{ key: 42 as unknown as string, englishSource: 'X' },
				{ key: 'a', englishSource: 'A' },
			]);
			assert.deepStrictEqual([...r.keys()], ['a']);
		});

		test('empty input → empty map', () => {
			assert.strictEqual(buildMetadataIndex([]).size, 0);
		});
	});
});
