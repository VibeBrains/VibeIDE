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

	const bound = (model: string) => model.includes('fable') || model.includes('mythos');

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
