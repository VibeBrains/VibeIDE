/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Tests for the `.vibe/.env` parser (vibeEnvFile.ts): KEY=VALUE lines, comments/blanks, `export`
 * prefix, quote stripping, malformed-key skipping, last-wins on duplicates.
 */

import * as assert from 'assert';
import { parseEnvFile } from '../../common/vibeEnvFile.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('vibeEnvFile — .vibe/.env parser', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses KEY=VALUE, ignores blanks and # comments', () => {
		const r = parseEnvFile('# comment\n\nMOONSHOT_API_KEY=sk-abc\n  # spaced comment\nFOO=bar\n');
		assert.strictEqual(r.MOONSHOT_API_KEY, 'sk-abc');
		assert.strictEqual(r.FOO, 'bar');
		assert.strictEqual(Object.keys(r).length, 2);
	});

	test('tolerates `export ` prefix and trims whitespace', () => {
		const r = parseEnvFile('export KEY = value-with-trim   ');
		assert.strictEqual(r.KEY, 'value-with-trim');
	});

	test('strips matching surrounding quotes (single and double)', () => {
		const r = parseEnvFile('A="quoted"\nB=\'single\'\nC=no"inner"strip');
		assert.strictEqual(r.A, 'quoted');
		assert.strictEqual(r.B, 'single');
		assert.strictEqual(r.C, 'no"inner"strip');
	});

	test('keeps `=` inside the value and preserves empty values', () => {
		const r = parseEnvFile('URL=https://x/y?a=1&b=2\nEMPTY=');
		assert.strictEqual(r.URL, 'https://x/y?a=1&b=2');
		assert.strictEqual(r.EMPTY, '');
	});

	test('skips malformed keys and lines without `=`', () => {
		const r = parseEnvFile('1BAD=x\n-bad=y\njust_text\nGOOD=z');
		assert.strictEqual(r['1BAD'], undefined);
		assert.strictEqual(r['-bad'], undefined);
		assert.strictEqual(r.GOOD, 'z');
		assert.strictEqual(Object.keys(r).length, 1);
	});

	test('last duplicate key wins', () => {
		const r = parseEnvFile('K=first\nK=second');
		assert.strictEqual(r.K, 'second');
	});

	test('empty / nullish input → empty object', () => {
		assert.deepStrictEqual(parseEnvFile(''), {});
		assert.deepStrictEqual(parseEnvFile(undefined), {});
		assert.deepStrictEqual(parseEnvFile(null), {});
	});
});
