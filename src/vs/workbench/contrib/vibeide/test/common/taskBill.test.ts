/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentRunRecord, AgentRunStatus } from '../../common/agentRunLedger.js';
import { taskBills } from '../../common/taskBill.js';

/**
 * Счёт за задачу: цена одной работы вместе с попытками, которые выбросили. Один прогон всегда
 * выглядит недорого — деньги уходят на третий заход к той же цели.
 */
suite('taskBill — цена задачи, а не запроса', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let seq = 0;
	const run = (p: Partial<AgentRunRecord> & { status: AgentRunStatus; tokensUsed: number }): AgentRunRecord => ({
		runId: p.runId ?? `r${++seq}`,
		epoch: 'e1',
		fence: { windowStartedAtMs: 1, seq: 1 },
		role: 'coder',
		goal: p.goal ?? 'починить сборку',
		parentThreadId: p.parentThreadId ?? 't1',
		startedAt: p.startedAt ?? 1_000,
		provider: p.provider ?? 'anthropic',
		model: p.model ?? 'claude',
		...p,
	});

	// $10/M in, $30/M out, blended at the module's 0.85 input weight = $13/M.
	const rate = () => ({ input: 10, output: 30 });
	const perM = (10 * 0.85 + 30 * 0.15);
	// Rounded on both sides: the assertions are about who pays for what, not about binary fractions.
	const round = (v: number | undefined) => v === undefined ? undefined : Math.round(v * 1e9) / 1e9;
	const usd = (tokens: number) => round(tokens / 1_000_000 * perM);

	test('две брошенные попытки и одна доведённая — задача стоит все три', () => {
		const report = taskBills([
			run({ runId: 'a', status: 'failed', tokensUsed: 100_000, startedAt: 1 }),
			run({ runId: 'b', status: 'stopped', tokensUsed: 200_000, startedAt: 2 }),
			run({ runId: 'c', status: 'completed', tokensUsed: 300_000, startedAt: 3, endedAt: 9 }),
		], rate);
		assert.deepStrictEqual({
			...report,
			tasks: report.tasks.map(t => ({ ...t, usd: round(t.usd), wastedUsd: round(t.wastedUsd) })),
			medianUsd: round(report.medianUsd),
			p90Usd: round(report.p90Usd),
		}, {
			tasks: [{
				threadId: 't1',
				goal: 'починить сборку',
				attempts: 3,
				discarded: 2,
				finished: true,
				tokens: 600_000,
				wastedTokens: 300_000,
				usd: usd(600_000),
				wastedUsd: usd(300_000),
				startedAt: 1,
				endedAt: 9,
			}],
			finished: 1,
			abandoned: 0,
			medianUsd: usd(600_000),
			p90Usd: usd(600_000),
			wastedShare: 0.5,
			unpricedTasks: 0,
		});
	});

	test('переформулированный повтор всё равно та же задача — связь сильнее текста цели', () => {
		const report = taskBills([
			run({ runId: 'a', status: 'failed', tokensUsed: 100_000, startedAt: 1, goal: 'починить сборку' }),
			run({ runId: 'b', status: 'completed', tokensUsed: 100_000, startedAt: 2, endedAt: 5, goal: 'ещё раз, теперь с тестами', replayOfRunId: 'a' }),
		], rate);
		assert.deepStrictEqual(
			[report.tasks.length, report.tasks[0].goal, report.tasks[0].attempts, report.tasks[0].discarded],
			[1, 'починить сборку', 2, 1],
		);
	});

	test('кэшированные токены не оплачиваются дважды, а брошенная задача не считается доведённой', () => {
		const report = taskBills([
			run({ runId: 'a', status: 'failed', tokensUsed: 100_000, cachedTokens: 40_000, startedAt: 1 }),
		], rate);
		assert.deepStrictEqual(
			[report.tasks[0].tokens, report.tasks[0].wastedTokens, report.finished, report.abandoned, report.medianUsd],
			[60_000, 60_000, 0, 1, undefined],
		);
	});

	test('модель без цены — задача уходит в «неизвестно», а не в «бесплатно»', () => {
		const report = taskBills([
			run({ runId: 'a', status: 'completed', tokensUsed: 100_000, startedAt: 1, model: 'своя' }),
		], () => undefined);
		assert.deepStrictEqual(
			[report.tasks[0].usd, report.tasks[0].tokens, report.unpricedTasks, report.wastedShare],
			[undefined, 100_000, 1, undefined],
		);
	});

	test('медиана и девятый дециль считаются по доведённым задачам, дорогая — сверху списка', () => {
		const report = taskBills([
			run({ runId: 'a', status: 'completed', tokensUsed: 100_000, startedAt: 1, endedAt: 2, goal: 'дешёвая', parentThreadId: 't1' }),
			run({ runId: 'b', status: 'completed', tokensUsed: 900_000, startedAt: 1, endedAt: 2, goal: 'дорогая', parentThreadId: 't2' }),
			run({ runId: 'c', status: 'running', tokensUsed: 500_000, startedAt: 1, goal: 'идёт', parentThreadId: 't3' }),
		], rate);
		assert.deepStrictEqual(
			[report.tasks.map(t => t.goal), report.finished, report.abandoned, round(report.medianUsd), round(report.p90Usd)],
			[['дорогая', 'идёт', 'дешёвая'], 2, 1, usd(500_000), usd(820_000)],
		);
	});
});
