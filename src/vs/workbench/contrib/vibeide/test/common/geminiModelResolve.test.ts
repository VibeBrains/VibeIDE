/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { geminiModelOptions, getModelCapabilities, getReservedOutputTokenSpace } from '../../common/modelCapabilities.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/**
 * Regression suite for the 2026-07-25 mispricing: every `gemini-3.x` id used to fall through the
 * catch-all `includes('gemini-3')` branch onto the PRO profile, and the fallback then overwrote the
 * price with a hardcoded zero — so the estimator printed $0.00 and cost routing treated the model
 * as free. Two independent defects, both covered below.
 */
suite('Gemini — model resolution, pricing and thinking levels', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const caps = (provider: 'gemini' | 'openRouter' | 'ollama', model: string) =>
		getModelCapabilities(provider, model, undefined);

	const shape = (provider: 'gemini' | 'openRouter' | 'ollama', model: string) => {
		const c = caps(provider, model);
		const slider = c.reasoningCapabilities ? c.reasoningCapabilities.reasoningSlider : undefined;
		return {
			recognized: c.recognizedModelName,
			cost: c.cost,
			effort: slider?.type === 'effort_slider' ? { values: slider.values, default: slider.default } : slider?.type,
		};
	};

	/**
	 * Flash carries the INTRODUCTORY rate — $0.75 / $3.75 until 01.01.2027 — because that is what the
	 * vendor bills today. The profile used to hold the 2027 number alone, which doubled every estimate
	 * a user saw through all of 2026; the schedule now swaps it over on the date.
	 */
	const flashCost = { input: 0.75, output: 3.75, cache_read: 0.075 };

	const flashLiteCost = { input: 0.30, output: 2.50, cache_read: 0.03 };
	const flashLevels = { values: ['minimal', 'low', 'medium', 'high'], default: 'medium' };
	const flashLiteLevels = { values: ['minimal', 'low', 'medium', 'high'], default: 'minimal' };
	// Pro has no 'minimal' level and defaults to 'high'; above 200K of prompt the whole request is billed at the higher rate
	const proShape = { recognized: 'gemini-3.1-pro-preview', cost: { input: 2.00, output: 12.00, cache_read: 0.20, long_context: { over_input_tokens: 200_000, input: 2, cache: 2, output: 1.5 } }, effort: { values: ['low', 'medium', 'high'], default: 'high' } };

	/** The vendor's current lineup, checked against ai.google.dev (models, pricing, deprecations) on 30.09.2026 */
	test('exact 3.x profiles carry vendor pricing and their own thinking levels', () => {
		assert.deepStrictEqual(
			[
				shape('gemini', 'gemini-3.8-flash'),
				shape('gemini', 'gemini-3.7-flash'),
				shape('gemini', 'gemini-3.6-flash'),
				shape('gemini', 'gemini-3.5-flash'),
				shape('gemini', 'gemini-3.5-flash-lite'),
				shape('gemini', 'gemini-3.1-flash-lite'),
				shape('gemini', 'gemini-3.1-pro-preview'),
			],
			[
				{ recognized: 'gemini-3.8-flash', cost: flashCost, effort: flashLevels },
				{ recognized: 'gemini-3.7-flash', cost: flashCost, effort: flashLevels },
				{ recognized: 'gemini-3.6-flash', cost: flashCost, effort: flashLevels },
				{ recognized: 'gemini-3.5-flash', cost: { input: 1.50, output: 9.00, cache_read: 0.15 }, effort: flashLevels },
				{ recognized: 'gemini-3.5-flash-lite', cost: flashLiteCost, effort: flashLiteLevels },
				{ recognized: 'gemini-3.1-flash-lite', cost: { input: 0.25, output: 1.50, cache_read: 0.025 }, effort: flashLiteLevels },
				proShape,
			],
		);
	});

	/**
	 * An id without its own row resolves by family on the direct provider too: there it used to get no profile at all,
	 * priced at zero. Retired ids land on the replacement the vendor names
	 */
	test('unknown and retired ids resolve by family, not onto Pro, and keep a non-zero price', () => {
		assert.deepStrictEqual(
			[
				shape('openRouter', 'google/gemini-3.5-flash-lite'),
				shape('openRouter', 'google/gemini-3.9-flash'),      // a Flash that does not exist yet
				shape('gemini', 'gemini-3.9-flash'),
				shape('openRouter', 'gemini-3.1-pro-preview'),
				shape('gemini', 'gemini-3-pro-preview'),             // retired 09.03.2026, the vendor names 3.1 Pro
				shape('gemini', 'gemini-2.5-flash-preview-04-17'),   // a retired 2.5 preview lands on the served 2.5 Flash
				shape('gemini', 'gemini-2.0-flash'),                 // retired 01.06.2026, the vendor names 3.6 Flash
			].map(({ recognized }) => recognized),
			[
				'gemini-3.5-flash-lite',
				'gemini-3.6-flash',
				'gemini-3.6-flash',
				'gemini-3.1-pro-preview',
				'gemini-3.1-pro-preview',
				'gemini-2.5-flash',
				'gemini-3.6-flash',
			],
		);
		assert.deepStrictEqual(shape('openRouter', 'google/gemini-3.1-pro-preview'), proShape);
	});

	test('every paid Gemini profile has a non-zero price', () => {
		// Widened to `number` on purpose: `as const` gives literal price types, and the compiler would
		// otherwise reject the comparison as "no overlap" today — leaving no guard for the profile
		// someone adds tomorrow with a price still to be filled in.
		const zeroPriced = Object.entries<{ cost: { input: number; output: number } }>(geminiModelOptions)
			.filter(([id]) => !id.includes('-exp-')) // experimental ids are free-tier only and never appear on the paid pricing page
			.filter(([, opts]) => opts.cost.input === 0 || opts.cost.output === 0)
			.map(([id]) => id);
		assert.deepStrictEqual(zeroPriced, []);
	});

	test('output space stays reserved once thinking is on', () => {
		// Thinking is always enabled on 3.x, and `getReservedOutputTokenSpace` switches to
		// `reasoningReservedOutputTokenSpace` in that state — an unset field would silently reserve
		// nothing (the caller does `|| 0`) and the context budget would think the whole window is free.
		const reserved = (model: string) =>
			getReservedOutputTokenSpace('gemini', model, { isReasoningEnabled: true, overridesOfModel: undefined });
		assert.deepStrictEqual(
			[reserved('gemini-3.8-flash'), reserved('gemini-3.6-flash'), reserved('gemini-3.5-flash-lite'), reserved('gemini-3.1-pro-preview')],
			[65_536, 65_536, 65_536, 65_536],
		);
	});

	test('GLM, Kimi and MiniMax resolve to priced profiles, not to the free-looking default', () => {
		// Each of these used to land on a zero price — GLM and Kimi had no resolver branch at all,
		// MiniMax carried `cost: {0,0}` under a comment claiming cost was unused for routing. It is
		// used: `modelRouter` scores `costPerM === 0` as a free model and prefers it.
		const priceOf = (model: string) => {
			const c = caps('openRouter', model).cost;
			return [c.input > 0, c.output > 0];
		};
		assert.deepStrictEqual(
			[priceOf('z-ai/glm-5'), priceOf('z-ai/glm-4.7'), priceOf('moonshotai/kimi-k2.5'), priceOf('minimax/minimax-m2.5')],
			[[true, true], [true, true], [true, true], [true, true]],
		);
	});

	test('local providers stay free — a recognized cloud sibling must not lend its price', () => {
		assert.deepStrictEqual(
			[caps('ollama', 'deepseek-r1').cost, caps('ollama', 'qwen2.5-coder:1.5b').cost],
			[{ input: 0, output: 0 }, { input: 0, output: 0 }],
		);
	});
});
