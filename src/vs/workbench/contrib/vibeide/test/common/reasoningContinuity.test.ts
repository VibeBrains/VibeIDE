/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { reasoningLostOnSwitch } from '../../common/reasoningContinuity.js';

/**
 * Losing reasoning on a model switch.
 *
 * The failure this guards is silence, not an error: blocks bound to one model are dropped by the
 * next one without a word, and the only symptom is that answers get shallower.
 */
suite('reasoning continuity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const bound = (model: string) => /fable|mythos|opus-5-5|sonnet-5-5|haiku-5-5/.test(model);

	test('switching away from a model-bound family loses the reasoning', () => {
		assert.strictEqual(
			reasoningLostOnSwitch({ fromModel: 'claude-fable-5-1', toModel: 'claude-opus-5', reasoningBoundToModel: bound }),
			true,
		);
	});

	/** The binding is to the model, not the vendor — a sibling model does not inherit the blocks. */
	test('a switch inside the same family is still a loss', () => {
		assert.strictEqual(
			reasoningLostOnSwitch({ fromModel: 'claude-fable-5-1', toModel: 'claude-mythos-5-1', reasoningBoundToModel: bound }),
			true,
		);
	});

	test('families whose reasoning travels are not reported', () => {
		assert.strictEqual(
			reasoningLostOnSwitch({ fromModel: 'claude-opus-5', toModel: 'minimax-m3', reasoningBoundToModel: bound }),
			false,
		);
	});

	/**
	 * The vendor names pairs whose blocks the next model reads: Opus 5.5 → Fable or Mythos 5.1, and Sonnet 5.5 → Opus 5.5 on the
	 * Claude API only. The blocks are bound to the account too, so another provider loses them
	 */
	test('pairs the vendor names as readable keep the reasoning, on the same provider only', () => {
		const lost = (fromModel: string, toModel: string, fromProvider?: string, toProvider?: string) =>
			reasoningLostOnSwitch({ fromModel, toModel, fromProvider, toProvider, reasoningBoundToModel: bound });
		assert.deepStrictEqual([
			lost('claude-opus-5-5', 'claude-fable-5-1', 'anthropic', 'anthropic'),
			lost('claude-opus-5-5', 'claude-mythos-5-1'),
			lost('claude-opus-5-5', 'claude-opus-5'),
			lost('claude-sonnet-5-5', 'claude-opus-5-5', 'anthropic', 'anthropic'),
			lost('claude-sonnet-5-5', 'claude-opus-5-5', 'openRouter', 'openRouter'),
			lost('claude-sonnet-5-5', 'claude-opus-5-5'),
			lost('claude-opus-5-5', 'claude-fable-5-1', 'anthropic', 'openRouter'),
			lost('claude-fable-5-1', 'claude-opus-5-5', 'anthropic', 'anthropic'),
			// Haiku 5.5 blocks are read by Opus 5.5 and Sonnet 5.5 on the Claude API, by nothing else
			lost('claude-haiku-5-5', 'claude-opus-5-5', 'anthropic', 'anthropic'),
			lost('claude-haiku-5-5', 'claude-sonnet-5-5', 'anthropic', 'anthropic'),
			lost('claude-haiku-5-5', 'claude-opus-5', 'anthropic', 'anthropic'),
			lost('claude-sonnet-5-5', 'claude-haiku-5-5', 'anthropic', 'anthropic'),
		], [false, false, true, false, true, true, true, true, false, false, true, true]);
	});

	/** Same model on a new provider keeps everything — warning there would be noise. */
	test('no switch, no warning', () => {
		assert.strictEqual(
			reasoningLostOnSwitch({ fromModel: 'claude-fable-5-1', toModel: 'claude-fable-5-1', reasoningBoundToModel: bound }),
			false,
		);
		assert.strictEqual(
			reasoningLostOnSwitch({ fromModel: '', toModel: 'claude-opus-5', reasoningBoundToModel: bound }),
			false,
		);
	});
});
