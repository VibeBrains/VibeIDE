/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentRunRecord } from '../../common/agentRunLedger.js';
import { describeRoleBudgetRefusal, describeRoleUsdRefusal, evaluateRoleBudget, evaluateRoleUsdBudget, sumRoleSpend, tokenQuotaForUsd } from '../../common/agentRoleBudget.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000;

function run(role: string, tokensUsed: number, startedAt: number, status: AgentRunRecord['status'] = 'completed'): AgentRunRecord {
	return {
		runId: `${role}-${startedAt}`,
		epoch: 'epoch-a',
		fence: { windowStartedAtMs: 1, seq: 1 },
		role,
		goal: 'цель',
		parentThreadId: 'thread-1',
		status,
		startedAt,
		tokensUsed,
	};
}

const RECORDS: readonly AgentRunRecord[] = [
	run('code-reviewer', 30_000, NOW - 2 * 60 * 60 * 1000),
	run('code-reviewer', 25_000, NOW - 5 * 60 * 60 * 1000),
	// Still working — its spend counts too, otherwise the ceiling is only enforced after the fact.
	run('code-reviewer', 10_000, NOW - 60 * 1000, 'running'),
	// Outside the window.
	run('code-reviewer', 90_000, NOW - 3 * DAY_MS),
	run('designer', 40_000, NOW - 60 * 60 * 1000),
];

suite('agentRoleBudget — cumulative ceiling per role', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('spend sums the window only, counts running runs, ignores other roles', () => {
		assert.deepStrictEqual(
			[
				sumRoleSpend(RECORDS, 'code-reviewer', NOW - DAY_MS),
				sumRoleSpend(RECORDS, 'designer', NOW - DAY_MS),
				sumRoleSpend(RECORDS, 'code-reviewer', NOW - 4 * DAY_MS),
				sumRoleSpend(RECORDS, 'qa', NOW - DAY_MS),
			],
			[65_000, 40_000, 155_000, 0],
		);
	});

	test('no budget means unlimited — never "limited to zero"', () => {
		assert.deepStrictEqual(
			[
				evaluateRoleBudget(RECORDS, 'code-reviewer', {}, NOW, 1),
				evaluateRoleBudget(RECORDS, 'code-reviewer', { 'code-reviewer': null }, NOW, 1),
				evaluateRoleBudget(RECORDS, 'code-reviewer', { 'code-reviewer': 0 }, NOW, 1),
			],
			[
				{ role: 'code-reviewer', spent: 65_000, exhausted: false },
				{ role: 'code-reviewer', spent: 65_000, exhausted: false },
				{ role: 'code-reviewer', spent: 65_000, exhausted: false },
			],
		);
	});

	test('a configured budget reports remaining and flips to exhausted at the ceiling', () => {
		assert.deepStrictEqual(
			[
				evaluateRoleBudget(RECORDS, 'code-reviewer', { 'code-reviewer': 100_000 }, NOW, 1),
				evaluateRoleBudget(RECORDS, 'code-reviewer', { 'code-reviewer': 65_000 }, NOW, 1),
				evaluateRoleBudget(RECORDS, 'code-reviewer', { 'code-reviewer': 50_000 }, NOW, 1),
			],
			[
				{ role: 'code-reviewer', budget: 100_000, spent: 65_000, remaining: 35_000, exhausted: false },
				{ role: 'code-reviewer', budget: 65_000, spent: 65_000, remaining: 0, exhausted: true },
				{ role: 'code-reviewer', budget: 50_000, spent: 65_000, remaining: 0, exhausted: true },
			],
		);
	});

	test('a wider window pulls older runs back into the bill', () => {
		assert.deepStrictEqual(
			[
				evaluateRoleBudget(RECORDS, 'code-reviewer', { 'code-reviewer': 100_000 }, NOW, 1).exhausted,
				evaluateRoleBudget(RECORDS, 'code-reviewer', { 'code-reviewer': 100_000 }, NOW, 7).exhausted,
			],
			[false, true],
		);
	});

	test('refusal names both numbers and the period, so the message cannot drift from the rule', () => {
		const state = evaluateRoleBudget(RECORDS, 'code-reviewer', { 'code-reviewer': 50_000 }, NOW, 1);
		// `toLocaleString('ru-RU')` groups digits with a non-breaking space, so a literal " " would
		// never match — normalise before asserting on the numbers.
		const text = describeRoleBudgetRefusal(state, 'Ревьюер', 1).replace(/[  ]/g, ' ');
		assert.deepStrictEqual(
			[text.includes('Ревьюер'), text.includes('65 000'), text.includes('50 000'), text.includes('сутки')],
			[true, true, true, true],
		);
	});
});

suite('agentRoleBudget — потолки в долларах', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// $10/M in, $30/M out → blended $13/M at the module's 0.85 input weight.
	const rate = () => ({ input: 10, output: 30 });
	const perM = 10 * 0.85 + 30 * 0.15;
	const round = (v: number | undefined) => v === undefined ? undefined : Math.round(v * 1e9) / 1e9;

	test('расход окна считается в деньгах по цене каждой модели', () => {
		// 30 000 + 25 000 + 10 000 токенов внутри суток; прогон трёхдневной давности не в счёт.
		const state = evaluateRoleUsdBudget(RECORDS, 'code-reviewer', { 'code-reviewer': { perDay: 10 } }, NOW, 1, rate);
		assert.deepStrictEqual(
			[round(state.spentUsd), state.unpricedRuns, state.exhausted, state.perDay],
			[round(65_000 / 1_000_000 * perM), 0, false, 10],
		);
	});

	test('потолок за окно исчерпан — прогон отклоняется, и отказ называет обе суммы', () => {
		const state = evaluateRoleUsdBudget(RECORDS, 'code-reviewer', { 'code-reviewer': { perDay: 0.5 } }, NOW, 1, rate);
		assert.strictEqual(state.exhausted, true);
		const text = describeRoleUsdRefusal(state, 'Ревьюер', 1);
		// $0.845 печатается как $0.84: `toFixed` округляет по двоичному представлению, и это
		// поведение самого форматирования — тест фиксирует его, а не прячет.
		assert.deepStrictEqual(
			[text.includes('$0.84'), text.includes('$0.50'), text.includes('сутки'), text.includes('посчитать не удалось')],
			[true, true, true, false],
		);
	});

	test('неизвестная цена не становится нулём: прогоны считаются отдельно и называются в отказе', () => {
		const state = evaluateRoleUsdBudget(RECORDS, 'code-reviewer', { 'code-reviewer': { perDay: 0.5 } }, NOW, 1, () => undefined);
		assert.deepStrictEqual(
			[state.spentUsd, state.unpricedRuns, state.exhausted],
			[undefined, 3, false],
		);
	});

	test('доллары за прогон превращаются в квоту токенов, а без цены модели — ни во что', () => {
		assert.deepStrictEqual(
			[
				tokenQuotaForUsd(1.3, { input: 10, output: 30 }),
				tokenQuotaForUsd(1.3, undefined),
				tokenQuotaForUsd(0, { input: 10, output: 30 }),
				tokenQuotaForUsd(undefined, { input: 10, output: 30 }),
			],
			[100_000, undefined, undefined, undefined],
		);
	});

	test('нулевой и отрицательный потолок — это «без ограничения», а не «запрещено всё»', () => {
		const state = evaluateRoleUsdBudget(RECORDS, 'code-reviewer', { 'code-reviewer': { perDay: 0, perRun: -1 } }, NOW, 1, rate);
		assert.deepStrictEqual([state.perDay, state.perRun, state.exhausted], [undefined, undefined, false]);
	});
});
