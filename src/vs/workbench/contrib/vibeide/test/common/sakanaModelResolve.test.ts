/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { getModelCapabilities } from '../../common/modelCapabilities.js';
import { costOf } from '../../common/spendLedger.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/**
 * Sakana Fugu rejects `low` and `medium` reasoning effort with an error instead of falling back to a
 * default — so a wrong slider is not a cosmetic issue here, it is a 400 on the first request. The ids
 * differ between routes as well: the vendor API calls Ultra v2 `fugu-ultra`, OpenRouter `fugu-ultra-v2`.
 */
suite('Sakana Fugu — profile, effort ladder and ids', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const shape = (provider: 'openAICompatible' | 'openRouter', model: string) => {
		const c = getModelCapabilities(provider, model, undefined);
		const slider = c.reasoningCapabilities ? c.reasoningCapabilities.reasoningSlider : undefined;
		return {
			recognized: c.recognizedModelName,
			cost: c.cost,
			canTurnOff: c.reasoningCapabilities ? c.reasoningCapabilities.canTurnOffReasoning : undefined,
			effort: slider?.type === 'effort_slider' ? { values: slider.values, default: slider.default } : slider?.type,
		};
	};

	const ladder = ['high', 'xhigh', 'max'];

	const round = (v: number | undefined) => v === undefined ? undefined : Math.round(v * 1e6) / 1e6;

	test('Max и Ultra: своя лестница усилий, размышление не выключается, цены вендора', () => {
		assert.deepStrictEqual(
			[shape('openAICompatible', 'fugu-max'), shape('openAICompatible', 'fugu-ultra')],
			[
				{ recognized: 'fugu-max', cost: { input: 2.00, output: 6.00, cache_read: 0.25 }, canTurnOff: false, effort: { values: ladder, default: 'high' } },
				{
					recognized: 'fugu-ultra',
					cost: { input: 5.00, output: 30.00, cache_read: 0.50, long_context: { over_input_tokens: 272_000, input: 2, output: 1.5, cache: 2 } },
					canTurnOff: false,
					effort: { values: ladder, default: 'xhigh' },
				},
			],
		);
	});

	test('длинный запрос к Ultra считается по ступени, короткий — по базовой цене', () => {
		const price = getModelCapabilities('openAICompatible', 'fugu-ultra', undefined).cost;
		assert.deepStrictEqual(
			// Rounded: the assertion is about the tier, not about binary fractions.
			[
				round(costOf(price, { input: 100_000, output: 1_000 })),
				round(costOf(price, { input: 300_000, output: 1_000 })),
			],
			// Base: 100K×$5/M + 1K×$30/M. Tiered: 300K×$10/M + 1K×$45/M.
			[0.53, 3.045],
		);
	});

	test('идентификатор Ultra на обоих маршрутах ведёт к профилю Ultra, прочие fugu — к Max', () => {
		assert.deepStrictEqual(
			['sakana/fugu-ultra-v2', 'fugu-ultra-v1.1', 'sakana/fugu-max', 'fugu-cyber'].map(id => shape('openRouter', id).recognized),
			['fugu-ultra', 'fugu-ultra', 'fugu-max', 'fugu-max'],
		);
	});
});
