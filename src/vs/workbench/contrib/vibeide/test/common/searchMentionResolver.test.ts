/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	validateSearchQuery,
	renderSearchMentionFragment,
	SearchHit,
} from '../../common/searchMentionResolver.js';

suite('@search mention resolver — pure helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('validateSearchQuery', () => {
		test('accepts a normal query', () => {
			const r = validateSearchQuery('foo bar');
			assert.deepStrictEqual(r, { ok: true, value: 'foo bar' });
		});

		test('trims surrounding whitespace', () => {
			const r = validateSearchQuery('  hello  ');
			assert.deepStrictEqual(r, { ok: true, value: 'hello' });
		});

		test('rejects non-string', () => {
			assert.deepStrictEqual(validateSearchQuery(undefined), { ok: false, reason: 'query-not-a-string' });
			assert.deepStrictEqual(validateSearchQuery(123), { ok: false, reason: 'query-not-a-string' });
			assert.deepStrictEqual(validateSearchQuery(null), { ok: false, reason: 'query-not-a-string' });
		});

		test('rejects empty string', () => {
			assert.deepStrictEqual(validateSearchQuery(''), { ok: false, reason: 'query-empty' });
			assert.deepStrictEqual(validateSearchQuery('   '), { ok: false, reason: 'query-empty' });
		});

		test('rejects oversize query', () => {
			const long = 'a'.repeat(201);
			assert.deepStrictEqual(validateSearchQuery(long), { ok: false, reason: 'query-too-long' });
		});

		test('rejects zero-width chars (paste injection guard)', () => {
			const r = validateSearchQuery('foo​bar');
			assert.deepStrictEqual(r, { ok: false, reason: 'query-contains-invisible-chars' });
		});

		test('rejects Bidi override chars', () => {
			const r = validateSearchQuery('foo‮bar');
			assert.deepStrictEqual(r, { ok: false, reason: 'query-contains-invisible-chars' });
		});
	});

	suite('renderSearchMentionFragment', () => {
		const hit = (filePath: string, line: number, lineText: string): SearchHit => ({ filePath, line, lineText });

		test('empty hits produces explicit no-match marker', () => {
			const out = renderSearchMentionFragment('foo', []);
			assert.ok(out.includes('@search results for "foo"'));
			assert.ok(out.includes('_no matches'));
		});

		test('renders hits with file:line and snippet', () => {
			const out = renderSearchMentionFragment('foo', [
				hit('src/a.ts', 10, 'function foo() {'),
				hit('src/b.ts', 5, '  return foo + 1'),
			]);
			assert.ok(out.includes('`src/a.ts:10`'));
			assert.ok(out.includes('function foo()'));
			assert.ok(out.includes('`src/b.ts:5`'));
			assert.ok(out.includes('showing 2 of 2 hits'));
		});

		test('caps number of hits via maxHits', () => {
			const hits = Array.from({ length: 50 }, (_, i) => hit('src/x.ts', i + 1, `line ${i}`));
			const out = renderSearchMentionFragment('q', hits, { maxHits: 5 });
			const matches = out.match(/`src\/x\.ts:/g) ?? [];
			assert.strictEqual(matches.length, 5);
			assert.ok(out.includes('truncated for context budget'));
		});

		test('truncates long single-line text via maxHitChars', () => {
			const longLine = 'x'.repeat(500);
			const out = renderSearchMentionFragment('q', [hit('a.ts', 1, longLine)], { maxHitChars: 50 });
			// 50 chars of x + ellipsis (1 char) = 51 chars total in the snippet.
			const match = out.match(/`x{50}…`/);
			assert.ok(match, `expected truncated snippet, got ${out}`);
		});

		test('respects maxChars budget across hits', () => {
			const hits = Array.from({ length: 100 }, (_, i) => hit('src/x.ts', i, 'short line ' + i));
			const out = renderSearchMentionFragment('q', hits, { maxChars: 200 });
			assert.ok(out.length <= 250, `unexpectedly long output: ${out.length}`);
		});

		test('escapes markdown metacharacters in query', () => {
			const out = renderSearchMentionFragment('foo*bar', []);
			assert.ok(out.includes('foo\\*bar'));
		});

		test('replaces backticks in snippets with grave-accent substitute', () => {
			const out = renderSearchMentionFragment('q', [hit('a.ts', 1, 'const x = `template`')]);
			assert.ok(!/`template`/.test(out.split('@search results')[1] ?? ''));
		});
	});
});
