/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildStepInput,
	parsePipelineFile,
	PipelineStepOutcome,
	shouldRunStep,
	VibePipelineStep,
} from '../../common/pipeline/vibePipelineFile.js';

const ok = (over: Partial<PipelineStepOutcome> = {}): PipelineStepOutcome => ({
	role: 'coder', status: 'success', summary: 'сделал', artifacts: ['src/a.ts'], ...over,
});

suite('vibePipelineFile — parsing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a valid file is parsed with optional fields preserved', () => {
		const parsed = parsePipelineFile({
			version: 1,
			pipelines: [{
				id: 'review', name: 'Ревью', steps: [
					{ role: 'coder', task: '  почини тесты  ', acceptance: 'тесты зелёные', maxTokens: 5000.7, maxSteps: 12, continueOnFailure: true },
					{ role: 'reviewer', task: 'проверь', ignorePreviousArtifacts: true },
				],
			}],
		});
		assert.deepStrictEqual(parsed, {
			warnings: [],
			file: {
				version: 1,
				pipelines: [{
					id: 'review', name: 'Ревью', steps: [
						{ role: 'coder', task: 'почини тесты', acceptance: 'тесты зелёные', maxTokens: 5000, maxSteps: 12, continueOnFailure: true },
						{ role: 'reviewer', task: 'проверь', ignorePreviousArtifacts: true },
					],
				}],
			},
		});
	});

	test('one broken pipeline is skipped, the good ones survive', () => {
		// The whole file failing over a single typo is what makes people stop using config files.
		const parsed = parsePipelineFile({
			pipelines: [
				{ id: 'good', steps: [{ role: 'coder', task: 'делай' }] },
				{ steps: [{ role: 'coder', task: 'без id' }] },
				{ id: 'empty', steps: [] },
				{ id: 'badstep', steps: [{ role: 'coder' }] },
				{ id: 'good', steps: [{ role: 'coder', task: 'дубль' }] },
			],
		});
		assert.deepStrictEqual(
			{ ids: parsed.file.pipelines.map(p => p.id), warnings: parsed.warnings },
			{
				ids: ['good'],
				warnings: [
					'pipelines[1]: нет поля id — пропущен',
					'pipelines[2] «empty»: нужен непустой массив steps — пропущен',
					'pipelines[3] «badstep», шаг 1: нет поля task — пайплайн пропущен',
					'pipelines[4]: id «good» уже занят — пропущен',
				],
			},
		);
	});

	test('a non-object root and a non-array pipelines field are reported, not thrown', () => {
		assert.deepStrictEqual(
			[parsePipelineFile(null), parsePipelineFile([]), parsePipelineFile({ pipelines: {} })].map(p => p.warnings),
			[
				['pipelines.json: корень должен быть объектом'],
				['pipelines.json: корень должен быть объектом'],
				['pipelines.json: поле pipelines должно быть массивом'],
			],
		);
	});

	test('more than twenty steps is refused — a runaway file must not spawn a fleet', () => {
		const steps = Array.from({ length: 21 }, () => ({ role: 'coder', task: 'go' }));
		const parsed = parsePipelineFile({ pipelines: [{ id: 'huge', steps }] });
		assert.deepStrictEqual(
			{ count: parsed.file.pipelines.length, warning: parsed.warnings[0] },
			{ count: 0, warning: 'pipelines[0] «huge»: больше 20 шагов — пропущен' },
		);
	});
});

suite('vibePipelineFile — handing work to the next step', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const step: VibePipelineStep = { role: 'reviewer', task: 'проверь работу' };

	test('the first step gets its task and nothing else', () => {
		assert.deepStrictEqual(buildStepInput(step, []), { goal: 'проверь работу', contextItems: [] });
	});

	test('paths accumulate across steps, the story comes only from the last one', () => {
		// Step three must still be able to open what step one created; hearing all three summaries
		// would turn the prompt into a diary.
		const input = buildStepInput(step, [
			ok({ role: 'architect', summary: 'спроектировал', artifacts: ['docs/plan.md'] }),
			ok({ role: 'coder', summary: 'написал код', artifacts: ['src/a.ts', 'docs/plan.md'] }),
		]);
		assert.deepStrictEqual(input, {
			goal: 'проверь работу\n\nПредыдущий шаг (coder) сообщил: написал код\n\nФайлы, затронутые предыдущими шагами (прочитайте нужные сами): docs/plan.md, src/a.ts',
			contextItems: ['docs/plan.md', 'src/a.ts'],
		});
	});

	test('acceptance criteria ride along with the task', () => {
		assert.strictEqual(
			buildStepInput({ role: 'coder', task: 'почини', acceptance: 'тесты зелёные' }, []).goal,
			'почини\n\nКритерий готовности: тесты зелёные',
		);
	});

	test('a step may ask for fresh eyes and gets no inheritance at all', () => {
		assert.deepStrictEqual(
			buildStepInput({ ...step, ignorePreviousArtifacts: true }, [ok()]),
			{ goal: 'проверь работу', contextItems: [] },
		);
	});

	test('nothing produced → no empty section is invented', () => {
		const input = buildStepInput(step, [ok({ summary: '', artifacts: [] })]);
		assert.deepStrictEqual(input, { goal: 'проверь работу', contextItems: [] });
	});

	test('a failure stops the line unless the step opted out', () => {
		const failed = [ok({ status: 'failed' })];
		assert.deepStrictEqual(
			[shouldRunStep(step, []), shouldRunStep(step, [ok()]), shouldRunStep(step, failed), shouldRunStep({ ...step, continueOnFailure: true }, failed)],
			[true, true, false, true],
		);
	});
});
