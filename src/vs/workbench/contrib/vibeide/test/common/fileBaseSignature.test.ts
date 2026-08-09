/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { blocksApply, captureFileBase, verifyFileBase } from '../../common/fileBaseSignature.js';

suite('Pre-apply verification — file base signature', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const read = (content: string) => captureFileBase(content, 'buffer');

	test('same content read the same way applies', () => {
		const verdict = verifyFileBase(read('const a = 1;\n'), captureFileBase('const a = 1;\n', 'buffer'));
		assert.deepStrictEqual({ verdict, blocks: blocksApply(verdict) }, { verdict: { kind: 'unchanged' }, blocks: false });
	});

	test('content changed under the agent blocks the write', () => {
		const verdict = verifyFileBase(read('const a = 1;\n'), captureFileBase('const a = 2;\n', 'buffer'));
		assert.deepStrictEqual({ verdict, blocks: blocksApply(verdict) }, { verdict: { kind: 'changed' }, blocks: true });
	});

	test('a one-character change is caught (no truncated-hash collisions)', () => {
		assert.notStrictEqual(captureFileBase('a', 'disk').hash, captureFileBase('b', 'disk').hash);
	});

	test('read from disk, writing against an editor buffer is reported as a source switch', () => {
		const verdict = verifyFileBase(captureFileBase('x\n', 'disk'), captureFileBase('x\n', 'buffer'));
		assert.deepStrictEqual(
			{ verdict, blocks: blocksApply(verdict) },
			{ verdict: { kind: 'source-changed', from: 'disk', to: 'buffer' }, blocks: true },
		);
	});

	test('no baseline is not this check\'s business — "must read first" covers it', () => {
		const verdict = verifyFileBase(undefined, captureFileBase('anything', 'disk'));
		assert.deepStrictEqual({ verdict, blocks: blocksApply(verdict) }, { verdict: { kind: 'no-baseline' }, blocks: false });
	});

	test('empty file has a stable signature (created-then-edited chain)', () => {
		const verdict = verifyFileBase(captureFileBase('', 'disk'), captureFileBase('', 'disk'));
		assert.deepStrictEqual(verdict, { kind: 'unchanged' });
	});
});
