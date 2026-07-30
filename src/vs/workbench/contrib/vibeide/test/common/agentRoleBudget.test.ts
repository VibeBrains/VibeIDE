/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentRunRecord } from '../../common/agentRunLedger.js';
import { describeRoleBudgetRefusal, evaluateRoleBudget, sumRoleSpend } from '../../common/agentRoleBudget.js';

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
