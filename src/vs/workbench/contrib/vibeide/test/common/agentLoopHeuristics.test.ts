/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { toolCallSignature, pickBudgetFillTail, resolveAntiLoopThreshold, planBudgetFillTail, endsWithQuestion } from '../../common/agentLoopHeuristics.js';

suite('agentLoopHeuristics', () => {

	suite('endsWithQuestion', () => {
		test('plain trailing question mark', () => {
			assert.strictEqual(endsWithQuestion('Приступать к реализации?'), true);
		});

		test('trailing whitespace / newline after the question mark', () => {
			assert.strictEqual(endsWithQuestion('Продолжать?\n'), true);
			assert.strictEqual(endsWithQuestion('Продолжать?   '), true);
		});

		test('markdown / quote / bracket tails after the question mark', () => {
			assert.strictEqual(endsWithQuestion('**Приступать?**'), true);
			assert.strictEqual(endsWithQuestion('вопрос?»'), true);
			assert.strictEqual(endsWithQuestion('(continue?)'), true);
			assert.strictEqual(endsWithQuestion('`run it?`'), true);
		});

		test('fullwidth question mark', () => {
			assert.strictEqual(endsWithQuestion('继续？'), true);
		});

		test('question mark in the MIDDLE does not count', () => {
			assert.strictEqual(endsWithQuestion('Вопрос? Ответ: да, продолжаю.'), false);
		});

		test('plain statements and empty input', () => {
			assert.strictEqual(endsWithQuestion('Готово.'), false);
			assert.strictEqual(endsWithQuestion(''), false);
		});
	});

	suite('toolCallSignature', () => {
		test('identical object params produce identical signatures regardless of key order', () => {
			const a = toolCallSignature('read_file', { uri: 'x.ts', start_line: 1, end_line: 50 });
			const b = toolCallSignature('read_file', { end_line: 50, uri: 'x.ts', start_line: 1 });
			assert.strictEqual(a, b);
		});

		test('different params produce different signatures', () => {
			const a = toolCallSignature('read_file', { uri: 'x.ts' });
			const b = toolCallSignature('read_file', { uri: 'y.ts' });
			assert.notStrictEqual(a, b);
		});

		test('different tool names produce different signatures even with same params', () => {
			const a = toolCallSignature('read_file', { uri: 'x.ts' });
			const b = toolCallSignature('grep', { uri: 'x.ts' });
			assert.notStrictEqual(a, b);
		});

		test('nested object values are preserved (not dropped by replacer-allowlist gotcha)', () => {
			const a = toolCallSignature('t', { opts: { mode: 'a' } });
			const b = toolCallSignature('t', { opts: { mode: 'b' } });
			assert.notStrictEqual(a, b, 'nested differences must change the signature');
		});

		test('string rawParams are used verbatim', () => {
			assert.strictEqual(toolCallSignature('run_command', 'ls -la'), 'run_command::ls -la');
		});

		test('null / undefined params normalize to empty object', () => {
			assert.strictEqual(toolCallSignature('t', null), toolCallSignature('t', undefined));
			assert.strictEqual(toolCallSignature('t', undefined), 't::{}');
		});

		test('circular reference falls back to a type-tagged stub instead of throwing', () => {
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			let sig = '';
			assert.doesNotThrow(() => { sig = toolCallSignature('t', circular); });
			assert.strictEqual(sig, 't::[unserializable:object]');
		});
	});

	suite('pickBudgetFillTail', () => {
		test('keeps all messages when everything fits the budget', () => {
			assert.strictEqual(pickBudgetFillTail([10, 10, 10], 1000), 0);
		});

		test('drops oldest messages when over budget, preferring the newest', () => {
			// budget 25 → keep from the end: 10 (+10=20) (+10=30 > 25 stop) → keep last two (idx 1)
			assert.strictEqual(pickBudgetFillTail([10, 10, 10], 25), 1);
		});

		test('always keeps at least the last message even if it exceeds budget', () => {
			assert.strictEqual(pickBudgetFillTail([5, 5, 999], 10), 2);
		});

		test('empty input returns 0 (nothing to keep, no overflow)', () => {
			assert.strictEqual(pickBudgetFillTail([], 100), 0);
		});

		test('exact-fit boundary keeps the message (uses > not >=)', () => {
			// last two sum to exactly 20 == budget → both kept (idx 1); third would push to 30
			assert.strictEqual(pickBudgetFillTail([10, 10, 10], 20), 1);
		});

		test('single message under budget is kept', () => {
			assert.strictEqual(pickBudgetFillTail([50], 100), 0);
		});
	});

	suite('planBudgetFillTail (honors pinned)', () => {
		const tok = (arr: Array<[number, boolean?]>) => arr.map(([tokens, pinned]) => ({ tokens, pinned }));

		test('no pinned → keeps recent tail, summarizes older head (matches pickBudgetFillTail)', () => {
			const plan = planBudgetFillTail(tok([[10], [10], [10]]), 25);
			assert.deepStrictEqual(plan.keepIndices, [1, 2]);
			assert.deepStrictEqual(plan.summarizeIndices, [0]);
		});

		test('pinned message in the head is lifted into keep (verbatim), in original order', () => {
			// budget 25 → tail = indices 3,4; index 0 pinned → also kept; 1,2 summarized
			const plan = planBudgetFillTail(tok([[10, true], [10], [10], [10], [10]]), 25);
			assert.deepStrictEqual(plan.keepIndices, [0, 3, 4]);
			assert.deepStrictEqual(plan.summarizeIndices, [1, 2]);
		});

		test('everything fits → all kept, nothing summarized', () => {
			const plan = planBudgetFillTail(tok([[5], [5, true], [5]]), 1000);
			assert.deepStrictEqual(plan.keepIndices, [0, 1, 2]);
			assert.deepStrictEqual(plan.summarizeIndices, []);
		});

		test('multiple pinned scattered through head all survive', () => {
			const plan = planBudgetFillTail(tok([[10, true], [10], [10, true], [10], [10]]), 15);
			// tail (budget 15) = index 4 only; pinned 0 and 2 lifted; 1,3 summarized
			assert.deepStrictEqual(plan.keepIndices, [0, 2, 4]);
			assert.deepStrictEqual(plan.summarizeIndices, [1, 3]);
		});

		test('empty input → empty plan', () => {
			const plan = planBudgetFillTail([], 100);
			assert.deepStrictEqual(plan.keepIndices, []);
			assert.deepStrictEqual(plan.summarizeIndices, []);
		});
	});

	suite('resolveAntiLoopThreshold', () => {
		test('disabled base (0) always returns 0 regardless of tool', () => {
			assert.strictEqual(resolveAntiLoopThreshold('run_command', 0), 0);
			assert.strictEqual(resolveAntiLoopThreshold('read_file', 0), 0);
		});

		test('strict tools get a lower threshold (base - 1)', () => {
			assert.strictEqual(resolveAntiLoopThreshold('run_command', 3), 2);
			assert.strictEqual(resolveAntiLoopThreshold('run_nl_command', 5), 4);
		});

		test('strict tools never drop below the floor of 2', () => {
			assert.strictEqual(resolveAntiLoopThreshold('run_command', 1), 2);
			assert.strictEqual(resolveAntiLoopThreshold('run_command', 2), 2);
		});

		test('lenient tools get a higher threshold (base + 1)', () => {
			assert.strictEqual(resolveAntiLoopThreshold('read_file', 3), 4);
			assert.strictEqual(resolveAntiLoopThreshold('edit_file', 3), 4);
		});

		test('unlisted tools keep the base threshold unchanged', () => {
			assert.strictEqual(resolveAntiLoopThreshold('grep', 3), 3);
			assert.strictEqual(resolveAntiLoopThreshold('search_for_files', 7), 7);
		});

		test('negative base is treated as disabled', () => {
			assert.strictEqual(resolveAntiLoopThreshold('run_command', -1), 0);
		});
	});
});
