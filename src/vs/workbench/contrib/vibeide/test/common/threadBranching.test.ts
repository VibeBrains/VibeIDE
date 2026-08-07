/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BranchMessageShape, resolveBranchCutoff } from '../../common/threadBranching.js';

const user: BranchMessageShape = { role: 'user' };
const assistant: BranchMessageShape = { role: 'assistant' };
const toolDone: BranchMessageShape = { role: 'tool', type: 'success' };
const toolPending: BranchMessageShape = { role: 'tool', type: 'tool_request' };
const toolRunning: BranchMessageShape = { role: 'tool', type: 'running_now' };
const checkpoint: BranchMessageShape = { role: 'checkpoint' };
const interrupted: BranchMessageShape = { role: 'interrupted_streaming_tool' };

suite('Thread branching — where a copy may be cut', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('cuts at the asked message, or walks back to the nearest valid end', () => {
		const thread = [user, assistant, toolDone, assistant, toolPending, checkpoint];
		assert.deepStrictEqual(
			{
				exact: resolveBranchCutoff(thread, 3),
				// Asked at an open tool call — walk BACK, never forward: forward would keep the very
				// messages the user is branching away from.
				openTool: resolveBranchCutoff(thread, 4),
				// A checkpoint is a file snapshot, not a turn; ending on it says nothing to the model.
				checkpointTail: resolveBranchCutoff(thread, 5),
				beyondEnd: resolveBranchCutoff(thread, 99),
				first: resolveBranchCutoff(thread, 0),
			},
			{ exact: 3, openTool: 3, checkpointTail: 3, beyondEnd: 3, first: 0 },
		);
	});

	test('nothing keepable and empty threads yield undefined', () => {
		assert.deepStrictEqual(
			{
				empty: resolveBranchCutoff([], 0),
				onlyOpen: resolveBranchCutoff([checkpoint, toolRunning, interrupted], 2),
			},
			{ empty: undefined, onlyOpen: undefined },
		);
	});
});
