/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mergeServedModels, parseServedModels, planModelDrift } from '../../common/vibePersistedPlanService.js';
import { parsePipelineFile } from '../../common/pipeline/vibePipelineFile.js';

/**
 * План помнит, кто на самом деле отвечал; шаг пайплайна может ждать конца пиковых цен.
 */
suite('planServedModels — ответившие модели плана и offPeak шага', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const planned = { provider: 'deepseek', model: 'deepseek-v4-pro' };

	test('ответившие модели: разбор, слияние без дублей, расхождение с одобренной', () => {
		assert.deepStrictEqual([
			parseServedModels([{ provider: 'deepseek', model: 'deepseek-flash' }, { provider: 1 }, 'мусор']),
			parseServedModels(undefined),
			mergeServedModels([planned], [planned, { provider: 'openRouter', model: 'deepseek/deepseek-v4-pro' }]),
			planModelDrift(planned, planned, true, [planned, { provider: 'deepseek', model: 'deepseek-v4-pro-20260914' }]),
			planModelDrift(planned, planned, true, [{ provider: 'deepseek', model: 'deepseek-flash' }]),
			planModelDrift(undefined, planned, true, [{ provider: 'deepseek', model: 'deepseek-flash' }]),
		], [
			[{ provider: 'deepseek', model: 'deepseek-flash' }],
			[],
			[planned, { provider: 'openRouter', model: 'deepseek/deepseek-v4-pro' }],
			[],
			[{ kind: 'served-other', planned, served: [{ provider: 'deepseek', model: 'deepseek-flash' }] }],
			[],
		]);
	});

	test('offPeak шага: разбирается с model, без model шаг отвергнут', () => {
		const parsed = parsePipelineFile({
			version: 1,
			pipelines: [
				{ id: 'ok', steps: [{ role: 'planner', task: 'план', model: 'deepseek/deepseek-flash', offPeak: true }] },
				{ id: 'bad', steps: [{ role: 'planner', task: 'план', offPeak: true }] },
			],
		});
		assert.deepStrictEqual(
			{ steps: parsed.file.pipelines.map(p => p.steps), warnings: parsed.warnings },
			{
				steps: [[{ role: 'planner', task: 'план', model: 'deepseek/deepseek-flash', offPeak: true }]],
				warnings: ['pipelines[1] «bad», шаг 1: поле offPeak требует model «провайдер/модель» — расписание цены есть только у модели — пайплайн пропущен'],
			},
		);
	});
});
