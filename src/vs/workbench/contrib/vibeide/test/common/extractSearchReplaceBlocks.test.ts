/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractSearchReplaceBlocks } from '../../common/helpers/extractCodeFromResult.js';
import { ORIGINAL, DIVIDER, FINAL } from '../../common/prompt/tools/_constants.js';

/**
 * Contract anchor for the destructive-edit guard in editCodeService._instantlyApplySRBlocks:
 * a block with an ORIGINAL marker but no divider parses as 'writingOriginal' with an EMPTY `final`.
 * The synchronous apply path MUST reject such a block — applying it would delete the matched code.
 * These tests pin the parser shapes that guard relies on.
 */
suite('extractSearchReplaceBlocks — block-state contract', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('complete block → state "done" with orig/final', () => {
		const input = `${ORIGINAL}\nfoo\n${DIVIDER}\nbar\n${FINAL}`;
		const blocks = extractSearchReplaceBlocks(input);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].state, 'done');
		assert.strictEqual(blocks[0].orig, 'foo');
		assert.strictEqual(blocks[0].final, 'bar');
	});

	test('ORIGINAL marker but NO divider → "writingOriginal" with EMPTY final (destructive shape)', () => {
		// This is the exact input that silently deleted code: only the search half was sent.
		const input = `${ORIGINAL}\nfoo`;
		const blocks = extractSearchReplaceBlocks(input);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].state, 'writingOriginal');
		assert.strictEqual(blocks[0].final, '', 'final must be empty — proves applying it would delete `orig`');
	});

	test('ORIGINAL + divider but NO closing FINAL → "writingFinal" (non-destructive: final has content)', () => {
		const input = `${ORIGINAL}\nfoo\n${DIVIDER}\nbar`;
		const blocks = extractSearchReplaceBlocks(input);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].state, 'writingFinal');
		assert.strictEqual(blocks[0].final, 'bar');
	});

	test('two complete blocks → both "done"', () => {
		const input = `${ORIGINAL}\nA\n${DIVIDER}\nX\n${FINAL}\n${ORIGINAL}\nB\n${DIVIDER}\nY\n${FINAL}`;
		const blocks = extractSearchReplaceBlocks(input);
		assert.strictEqual(blocks.length, 2);
		assert.ok(blocks.every(b => b.state === 'done'));
	});

	test('no ORIGINAL marker at all → no blocks', () => {
		assert.deepStrictEqual(extractSearchReplaceBlocks('just some text\nwith no markers'), []);
	});

	test('guard predicate: a writingOriginal block is detectable via state', () => {
		// Mirrors the guard condition `blocks.some(b => b.state === 'writingOriginal')`.
		const input = `${ORIGINAL}\nfoo`;
		const blocks = extractSearchReplaceBlocks(input);
		assert.ok(blocks.some(b => b.state === 'writingOriginal'));
	});
});
