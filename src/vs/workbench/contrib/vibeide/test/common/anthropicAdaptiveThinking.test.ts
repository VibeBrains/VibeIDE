/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getModelCapabilities, getProviderCapabilities } from '../../common/modelCapabilities.js';

/**
 * У Opus 4.7 и всей линейки 5 старый формат мышления отвечает 400: бюджет заменён уровнем.
 * Проверяется то, что уедет на провод, и то, каким ползунком модель описана.
 */
suite('anthropic — адаптивное мышление уровнем, а не бюджетом', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const payloadOf = (reasoning: Parameters<NonNullable<NonNullable<NonNullable<ReturnType<typeof getProviderCapabilities>['providerReasoningIOSettings']>['input']>['includeInPayload']>>[0]) =>
		getProviderCapabilities('anthropic').providerReasoningIOSettings?.input?.includeInPayload?.(reasoning) ?? null;

	test('уровень уходит как adaptive + output_config, бюджет — прежним enabled', () => {
		assert.deepStrictEqual([
			payloadOf({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'high' }),
			payloadOf({ type: 'budget_slider_value', isReasoningEnabled: true, reasoningBudget: 4096 }),
			payloadOf(null),
		], [
			{ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
			{ thinking: { type: 'enabled', budget_tokens: 4096 } },
			null,
		]);
	});

	test('имена линейки 5 и Opus 4.7/4.8 сводятся к записи с уровнем, а не к бюджетному ползунку', () => {
		const sliderOf = (modelName: string) => {
			const capabilities = getModelCapabilities('anthropic', modelName, undefined);
			return capabilities.reasoningCapabilities ? capabilities.reasoningCapabilities.reasoningSlider?.type : 'нет мышления';
		};
		assert.deepStrictEqual(
			['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-5-20250929'].map(sliderOf),
			['effort_slider', 'effort_slider', 'effort_slider', 'effort_slider', 'budget_slider'],
		);
	});
});
