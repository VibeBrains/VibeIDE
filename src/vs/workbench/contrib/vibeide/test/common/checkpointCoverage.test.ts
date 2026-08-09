/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { checkpointCoverage, isShellToolName } from '../../common/checkpointCoverage.js';

suite('Checkpoint rollback coverage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('snapshot present: offer a restore only when something actually drifted', () => {
		assert.deepStrictEqual(
			{
				drifted: checkpointCoverage({ hasSnapshot: true, wouldChangeAnything: true, shellCallCount: 2 }),
				clean: checkpointCoverage({ hasSnapshot: true, wouldChangeAnything: false, shellCallCount: 2 }),
			},
			{ drifted: { kind: 'restorable' }, clean: { kind: 'complete' } },
		);
	});

	test('no snapshot but commands ran: the user is told the rollback is partial', () => {
		assert.deepStrictEqual(
			checkpointCoverage({ hasSnapshot: false, wouldChangeAnything: undefined, shellCallCount: 3 }),
			{ kind: 'uncovered', shellCallCount: 3 },
		);
	});

	test('no snapshot and no commands: the chat tracked everything, stay silent', () => {
		assert.deepStrictEqual(
			checkpointCoverage({ hasSnapshot: false, wouldChangeAnything: undefined, shellCallCount: 0 }),
			{ kind: 'complete' },
		);
	});

	test('only shell tools count as outside the chat tracking', () => {
		assert.deepStrictEqual(
			['run_command', 'run_persistent_command', 'edit_file', 'read_file'].map(isShellToolName),
			[true, true, false, false],
		);
	});
});
