/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { checkpointCoverage, isShellToolName, toolNamesForCoverage } from '../../common/checkpointCoverage.js';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';

suite('Checkpoint rollback coverage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('snapshot present: offer a restore only when something actually drifted', () => {
		assert.deepStrictEqual(
			{
				drifted: checkpointCoverage({ hasSnapshot: true, wouldChangeAnything: true, toolNames: ['run_command', 'run_command'] }),
				clean: checkpointCoverage({ hasSnapshot: true, wouldChangeAnything: false, toolNames: ['run_command', 'run_command'] }),
			},
			{ drifted: { kind: 'restorable' }, clean: { kind: 'complete' } },
		);
	});

	test('no snapshot but commands ran: the user is told the rollback is partial', () => {
		assert.deepStrictEqual(
			checkpointCoverage({ hasSnapshot: false, wouldChangeAnything: undefined, toolNames: ['run_command', 'edit_file', 'run_persistent_command', 'run_nl_command'] }),
			{ kind: 'uncovered', shellCallCount: 3 },
		);
	});

	test('no snapshot and no commands: the chat tracked everything, stay silent', () => {
		assert.deepStrictEqual(
			checkpointCoverage({ hasSnapshot: false, wouldChangeAnything: undefined, toolNames: ['read_file', 'edit_file'] }),
			{ kind: 'complete' },
		);
	});

	test('only shell tools count as outside the chat tracking', () => {
		assert.deepStrictEqual(
			['run_command', 'run_persistent_command', 'edit_file', 'read_file'].map(isShellToolName),
			[true, true, false, false],
		);
	});

	// The built-in agent names its tools; an external agent runs its own and reports a kind, which is what is stable
	test('tool names of a stretch: built-in tools by name, external commands by ACP kind', () => {
		const acp = (toolKind: string, name = ''): ChatMessage => ({ role: 'acp_tool', toolCallId: toolKind, title: '', name, toolKind, status: 'completed', paths: [], diffs: [], output: '' });
		const messages: ChatMessage[] = [
			{ role: 'tool', name: 'read_file' } as ChatMessage,
			acp('execute', 'Bash'),
			acp('edit', 'Edit'),
			acp('', 'Bash'),
		];
		assert.deepStrictEqual(toolNamesForCoverage(messages), ['read_file', 'run_command']);
	});

	test('an external agent\'s command without a snapshot is reported as uncovered', () => {
		const command: ChatMessage = { role: 'acp_tool', toolCallId: '1', title: 'npm run format', name: '', toolKind: 'execute', status: 'completed', paths: [], diffs: [], output: '' };
		assert.deepStrictEqual(
			checkpointCoverage({ hasSnapshot: false, wouldChangeAnything: null, toolNames: toolNamesForCoverage([command]) }),
			{ kind: 'uncovered', shellCallCount: 1 },
		);
	});
});
