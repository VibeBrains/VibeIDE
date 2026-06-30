/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decideWorkflowTrigger,
	summarizeWorkflowTriggers,
} from '../../common/projectCommandsWorkflowTrigger.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Project Commands ↔ VibeWorkflowService — entry-point trigger', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideWorkflowTrigger', () => {
		test('no workflowId → launch-shell', () => {
			const r = decideWorkflowTrigger({
				command: {},
				knownWorkflowIds: new Set(),
			});
			assert.strictEqual(r.kind, 'launch-shell');
		});

		test('valid workflowId in known set → launch-workflow', () => {
			const r = decideWorkflowTrigger({
				command: { workflowId: 'release-flow' },
				knownWorkflowIds: new Set(['release-flow', 'other']),
			});
			assert.strictEqual(r.kind, 'launch-workflow');
			if (r.kind === 'launch-workflow') { assert.strictEqual(r.workflowId, 'release-flow'); }
		});

		test('malformed workflowId → refused: workflow-id-malformed', () => {
			const r = decideWorkflowTrigger({
				command: { workflowId: 'BAD ID' },
				knownWorkflowIds: new Set(),
			});
			assert.strictEqual(r.kind, 'refused');
			if (r.kind === 'refused') { assert.strictEqual(r.reason, 'workflow-id-malformed'); }
		});

		test('upper-case rejected', () => {
			const r = decideWorkflowTrigger({
				command: { workflowId: 'Build' },
				knownWorkflowIds: new Set(['Build']),
			});
			assert.strictEqual(r.kind, 'refused');
		});

		test('starts with hyphen rejected', () => {
			const r = decideWorkflowTrigger({
				command: { workflowId: '-leading' },
				knownWorkflowIds: new Set(),
			});
			assert.strictEqual(r.kind, 'refused');
		});

		test('over-long rejected', () => {
			const r = decideWorkflowTrigger({
				command: { workflowId: 'a'.repeat(200) },
				knownWorkflowIds: new Set(),
			});
			assert.strictEqual(r.kind, 'refused');
		});

		test('valid id not in known set → refused: workflow-not-found', () => {
			const r = decideWorkflowTrigger({
				command: { workflowId: 'unknown-flow' },
				knownWorkflowIds: new Set(['known-flow']),
			});
			assert.strictEqual(r.kind, 'refused');
			if (r.kind === 'refused') { assert.strictEqual(r.reason, 'workflow-not-found'); }
		});

		test('workflowId null treated as undefined', () => {
			const r = decideWorkflowTrigger({
				command: { workflowId: null as unknown as undefined },
				knownWorkflowIds: new Set(),
			});
			assert.strictEqual(r.kind, 'launch-shell');
		});

		test('non-string workflowId rejected', () => {
			const r = decideWorkflowTrigger({
				command: { workflowId: 42 as unknown as string },
				knownWorkflowIds: new Set(),
			});
			assert.strictEqual(r.kind, 'refused');
		});
	});

	suite('summarizeWorkflowTriggers (bulk)', () => {
		test('partitions into workflow / shell / refused', () => {
			const r = summarizeWorkflowTriggers(
				[
					{ id: 'a', workflowId: 'flow-1' },
					{ id: 'b' },
					{ id: 'c', workflowId: 'flow-missing' },
					{ id: 'd', workflowId: 'BAD' },
				],
				new Set(['flow-1']),
			);
			assert.deepStrictEqual(r.workflow, [{ commandId: 'a', workflowId: 'flow-1' }]);
			assert.deepStrictEqual(r.shell, [{ commandId: 'b' }]);
			assert.deepStrictEqual(r.refused, [
				{ commandId: 'c', reason: 'workflow-not-found' },
				{ commandId: 'd', reason: 'workflow-id-malformed' },
			]);
		});

		test('empty input → all empty', () => {
			const r = summarizeWorkflowTriggers([], new Set());
			assert.deepStrictEqual(r, { workflow: [], shell: [], refused: [] });
		});

		test('preserves input order', () => {
			const r = summarizeWorkflowTriggers(
				[
					{ id: 'z' },
					{ id: 'a' },
				],
				new Set(),
			);
			assert.deepStrictEqual(r.shell.map(s => s.commandId), ['z', 'a']);
		});
	});
});
