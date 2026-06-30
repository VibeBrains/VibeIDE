/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { encodeQrMatrix } from '../../common/vibeQrEncode.js';

suite('Vibe QR encoder', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('picks version by length (21/25/29) and rejects oversize', () => {
		assert.strictEqual(encodeQrMatrix('x'.repeat(10)).length, 21); // v1
		assert.strictEqual(encodeQrMatrix('x'.repeat(20)).length, 25); // v2
		assert.strictEqual(encodeQrMatrix('x'.repeat(35)).length, 29); // v3
		assert.throws(() => encodeQrMatrix('x'.repeat(43)));
	});

	test('matrix is square and boolean', () => {
		const m = encodeQrMatrix('http://127.0.0.1:5500/');
		assert.ok(m.every(row => row.length === m.length));
		assert.ok(m.every(row => row.every(cell => typeof cell === 'boolean')));
	});

	test('finder patterns present in all three corners', () => {
		const m = encodeQrMatrix('http://127.0.0.1:5500/');
		const n = m.length;
		const finderOk = (r: number, c: number) =>
			m[r][c] === true &&            // outer corner dark
			m[r + 1][c + 1] === false &&   // white ring
			m[r + 3][c + 3] === true;      // 3×3 dark centre
		assert.ok(finderOk(0, 0), 'top-left finder');
		assert.ok(finderOk(0, n - 7), 'top-right finder');
		assert.ok(finderOk(n - 7, 0), 'bottom-left finder');
	});

	test('timing pattern alternates on row/col 6', () => {
		const m = encodeQrMatrix('http://127.0.0.1:5500/');
		assert.strictEqual(m[6][8], true);
		assert.strictEqual(m[6][9], false);
		assert.strictEqual(m[8][6], true);
		assert.strictEqual(m[9][6], false);
	});

	test('deterministic — same input yields same matrix', () => {
		assert.deepStrictEqual(encodeQrMatrix('vibe-server'), encodeQrMatrix('vibe-server'));
	});
});
