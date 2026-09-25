/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { compactPipelineRunJournal, parsePipelineRunJournal, pipelineShapeOf, PipelineRunRecord, resumableRunOf, serializePipelineRun } from '../../common/pipeline/pipelineRunJournal.js';
import { PipelineStepOutcome, VibePipeline } from '../../common/pipeline/vibePipelineFile.js';

/** An interrupted pipeline run continues from its unfinished steps — the numbers AND the outcomes of the finished ones are kept */
suite('pipeline run journal', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const pipeline: Pick<VibePipeline, 'id' | 'steps'> = {
		id: 'feature',
		steps: [{ role: 'planner', task: 'план' }, { role: 'frontend', task: 'экран', wave: 'build' }, { role: 'backend', task: 'api', wave: 'build' }, { role: 'qa', task: 'тесты', wave: 'build' }, { role: 'code-reviewer', task: 'ревью' }],
	};
	const outcome = (step: number, status: PipelineStepOutcome['status'] = 'success'): PipelineStepOutcome => ({ role: pipeline.steps[step - 1].role, step, status, summary: `шаг ${step}`, artifacts: [`f${step}.ts`] });
	const run = (extra: Partial<PipelineRunRecord>): PipelineRunRecord => ({
		runId: 'r1', pipelineId: 'feature', shape: pipelineShapeOf(pipeline), totalSteps: 5, status: 'stopped', epoch: 'old',
		startedAt: 1_000, heartbeatAt: 1_000, outcomes: [outcome(1), outcome(2), outcome(3, 'stopped'), outcome(4)], ...extra,
	});
	const now = 1_000_000;
	const stale = 90_000;

	test('the last line of a run wins, a torn line is skipped', () => {
		const text = serializePipelineRun(run({ status: 'running' })) + '{"runId": "torn' + '\n' + serializePipelineRun(run({ status: 'failed' }));
		assert.deepStrictEqual(parsePipelineRunJournal(text).map(r => r.status), ['failed']);
	});

	test('a run stopped mid-wave continues from its first unfinished step, finished wave members are kept', () => {
		const resumable = resumableRunOf([run({})], pipeline, 'now', now, stale);
		assert.deepStrictEqual(resumable && { from: resumable.fromStep, done: [...resumable.done].sort(), reason: resumable.reason }, { from: 2, done: [0, 1, 3], reason: 'stopped' });
	});

	test('which runs may be continued', () => {
		const cases: Array<[string, PipelineRunRecord[], Pick<VibePipeline, 'id' | 'steps'>]> = [
			['failed', [run({ status: 'failed' })], pipeline],
			['window closed', [run({ status: 'running', epoch: 'old', heartbeatAt: now - stale - 1 })], pipeline],
			['still running in another window', [run({ status: 'running', epoch: 'old', heartbeatAt: now - 1_000 })], pipeline],
			['running in this window', [run({ status: 'running', epoch: 'now', heartbeatAt: 0 })], pipeline],
			['completed', [run({ status: 'completed' })], pipeline],
			['nothing finished', [run({ outcomes: [outcome(1, 'failed')] })], pipeline],
			['steps changed since', [run({})], { id: 'feature', steps: [...pipeline.steps.slice(0, 4), { role: 'critic', task: 'ревью' }] }],
			['a newer run finished', [run({}), run({ runId: 'r2', startedAt: 2_000, status: 'completed' })], pipeline],
		];
		assert.deepStrictEqual(
			cases.map(([name, records, p]) => [name, resumableRunOf(records, p, 'now', now, stale)?.reason ?? null]),
			[['failed', 'failed'], ['window closed', 'orphaned'], ['still running in another window', null], ['running in this window', null], ['completed', null], ['nothing finished', null], ['steps changed since', null], ['a newer run finished', null]],
		);
	});

	test('the journal keeps the newest runs within the retention, and never drops a run under way', () => {
		const day = 24 * 60 * 60 * 1000;
		const records = [run({ runId: 'old', startedAt: now - 40 * day }), run({ runId: 'live', startedAt: now - 40 * day, status: 'running' }), run({ runId: 'a', startedAt: now - day }), run({ runId: 'b', startedAt: now })];
		assert.deepStrictEqual(compactPipelineRunJournal(records, now, 1, 30).map(r => r.runId), ['live', 'b']);
	});
});
