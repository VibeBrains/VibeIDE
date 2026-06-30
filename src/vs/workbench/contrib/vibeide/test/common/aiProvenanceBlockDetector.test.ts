/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { detectProvenanceBlocks, renderProvenanceHover } from '../../common/aiProvenanceBlockDetector.js';

suite('aiProvenanceBlockDetector', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns empty when no marker present', () => {
		const blocks = detectProvenanceBlocks([
			'function foo() {',
			'  return 1;',
			'}',
		]);
		assert.strictEqual(blocks.length, 0);
	});

	test('detects single marker and runs block to next blank line', () => {
		const blocks = detectProvenanceBlocks([
			'// @ai-generated claude-sonnet-4-6 2026-05-08T12:00:00Z',
			'function foo() {',
			'  return 1;',
			'}',
			'',
			'function bar() {}',
		]);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].markerLine, 1);
		assert.strictEqual(blocks[0].blockStart, 2);
		assert.strictEqual(blocks[0].blockEnd, 4);
		assert.strictEqual(blocks[0].modelId, 'claude-sonnet-4-6');
		assert.strictEqual(blocks[0].timestamp, '2026-05-08T12:00:00Z');
	});

	test('two markers — second closes the first', () => {
		const blocks = detectProvenanceBlocks([
			'// @ai-generated m1 t1',
			'a',
			'// @ai-generated m2 t2',
			'b',
		]);
		assert.strictEqual(blocks.length, 2);
		assert.strictEqual(blocks[0].markerLine, 1);
		assert.strictEqual(blocks[0].blockEnd, 2);
		assert.strictEqual(blocks[1].markerLine, 3);
		assert.strictEqual(blocks[1].blockEnd, 4);
	});

	test('marker at EOF without body — blockEnd equals markerLine', () => {
		const blocks = detectProvenanceBlocks([
			'foo',
			'// @ai-generated m t',
		]);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].markerLine, 2);
		assert.strictEqual(blocks[0].blockEnd, 2);
	});

	test('hover renders RU markdown with model + timestamp + line range', () => {
		const md = renderProvenanceHover({
			markerLine: 10, blockStart: 11, blockEnd: 25,
			modelId: 'gpt-5', timestamp: '2026-05-08',
		});
		assert.ok(md.includes('AI-generated block'));
		assert.ok(md.includes('gpt-5'));
		assert.ok(md.includes('2026-05-08'));
		assert.ok(md.includes('10–25'));
	});
});
