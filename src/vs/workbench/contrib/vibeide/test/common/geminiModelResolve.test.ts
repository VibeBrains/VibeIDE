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

	test('exact 3.x profiles carry vendor pricing and their own thinking levels', () => {
		assert.deepStrictEqual(
			[shape('gemini', 'gemini-3.6-flash'), shape('gemini', 'gemini-3.5-flash-lite'), shape('gemini', 'gemini-3-pro-preview')],
			[
				{ recognized: 'gemini-3.6-flash', cost: { input: 1.50, output: 7.50 }, effort: { values: ['minimal', 'low', 'medium', 'high'], default: 'medium' } },
				{ recognized: 'gemini-3.5-flash-lite', cost: { input: 0.30, output: 2.50 }, effort: { values: ['minimal', 'low', 'medium', 'high'], default: 'minimal' } },
				// Pro has no 'minimal' level and defaults to 'high'.
				{ recognized: 'gemini-3-pro-preview', cost: { input: 2.00, output: 12.00 }, effort: { values: ['low', 'medium', 'high'], default: 'high' } },
			],
		);
	});

	test('unknown 3.x ids resolve by family, not onto Pro, and keep a non-zero price', () => {
		assert.deepStrictEqual(
			[
				shape('openRouter', 'google/gemini-3.6-flash'),
				shape('openRouter', 'google/gemini-3.5-flash-lite'),
				shape('openRouter', 'google/gemini-3.9-flash'),      // a Flash that does not exist yet
				shape('openRouter', 'google/gemini-3.1-flash-lite'), // a Flash-Lite that we have no profile for
				shape('openRouter', 'gemini-3.1-pro-preview'),       // Pro really does belong on the Pro profile
			],
			[
				{ recognized: 'gemini-3.6-flash', cost: { input: 1.50, output: 7.50 }, effort: { values: ['minimal', 'low', 'medium', 'high'], default: 'medium' } },
				{ recognized: 'gemini-3.5-flash-lite', cost: { input: 0.30, output: 2.50 }, effort: { values: ['minimal', 'low', 'medium', 'high'], default: 'minimal' } },
				{ recognized: 'gemini-3.6-flash', cost: { input: 1.50, output: 7.50 }, effort: { values: ['minimal', 'low', 'medium', 'high'], default: 'medium' } },
				{ recognized: 'gemini-3.5-flash-lite', cost: { input: 0.30, output: 2.50 }, effort: { values: ['minimal', 'low', 'medium', 'high'], default: 'minimal' } },
				{ recognized: 'gemini-3-pro-preview', cost: { input: 2.00, output: 12.00 }, effort: { values: ['low', 'medium', 'high'], default: 'high' } },
			],
		);
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
			[reserved('gemini-3.6-flash'), reserved('gemini-3.5-flash-lite'), reserved('gemini-3-pro-preview')],
			[65_536, 65_536, 65_536],
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
