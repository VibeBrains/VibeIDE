/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	transitionLoop,
	rankRoadmapItemsForExecution,
	summarizeLoopOutcomes,
	LoopState,
	RoadmapItem,
} from '../../common/roadmapAgentLoop.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const idle: LoopState = { kind: 'idle' };
const selecting: LoopState = { kind: 'selecting' };
const summary = { closed: 0, skeleton: 0, blocked: 0, skipped: 0 };

function item(overrides: Partial<RoadmapItem>): RoadmapItem {
	return {
		id: 'i1',
		summary: 's',
		bucket: 'must-finish',
		priority: 100,
		...overrides,
	};
}

suite('Roadmap-agent execution loop FSM', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('transitionLoop', () => {
		test('idle + start → selecting', () => {
			const r = transitionLoop(idle, { kind: 'start' });
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.next.kind, 'selecting'); }
		});

		test('idle + anything-else → refused', () => {
			const r = transitionLoop(idle, { kind: 'item-selected', itemId: 'x' });
			assert.strictEqual(r.ok, false);
		});

		test('selecting + item-selected → working', () => {
			const r = transitionLoop(selecting, { kind: 'item-selected', itemId: 'i1' });
			if (r.ok && r.next.kind === 'working') {
				assert.strictEqual(r.next.currentItemId, 'i1');
				assert.strictEqual(r.next.status.kind, 'in-progress');
			}
		});

		test('selecting + no-more-items → finished', () => {
			const r = transitionLoop(selecting, { kind: 'no-more-items', summary });
			if (r.ok && r.next.kind === 'finished') {
				assert.deepStrictEqual(r.next.summary, summary);
			}
		});

		test('working + preview-ready → awaiting-approval status', () => {
			const r = transitionLoop(
				{ kind: 'working', currentItemId: 'i1', status: { kind: 'in-progress', invocationId: 'inv1' } },
				{ kind: 'preview-ready', invocationId: 'inv1' },
			);
			if (r.ok && r.next.kind === 'working') {
				assert.strictEqual(r.next.status.kind, 'awaiting-approval');
			}
		});

		test('working + auto-approved → executing (skips approval state)', () => {
			const r = transitionLoop(
				{ kind: 'working', currentItemId: 'i1', status: { kind: 'in-progress', invocationId: 'inv1' } },
				{ kind: 'auto-approved', invocationId: 'inv1' },
			);
			if (r.ok && r.next.kind === 'working') {
				assert.strictEqual(r.next.status.kind, 'executing');
			}
		});

		test('working + user-approved → executing', () => {
			const r = transitionLoop(
				{ kind: 'working', currentItemId: 'i1', status: { kind: 'awaiting-approval', invocationId: 'inv1' } },
				{ kind: 'user-approved', invocationId: 'inv1' },
			);
			if (r.ok && r.next.kind === 'working') { assert.strictEqual(r.next.status.kind, 'executing'); }
		});

		test('working + user-rejected → back to selecting', () => {
			const r = transitionLoop(
				{ kind: 'working', currentItemId: 'i1', status: { kind: 'awaiting-approval', invocationId: 'inv1' } },
				{ kind: 'user-rejected', reason: 'too-risky' },
			);
			if (r.ok) {
				assert.strictEqual(r.next.kind, 'selecting');
				assert.ok(r.note?.includes('too-risky'));
			}
		});

		test('working + execution-complete → selecting', () => {
			const r = transitionLoop(
				{ kind: 'working', currentItemId: 'i1', status: { kind: 'executing', invocationId: 'inv1' } },
				{ kind: 'execution-complete', outcome: 'success' },
			);
			if (r.ok) {
				assert.strictEqual(r.next.kind, 'selecting');
				assert.ok(r.note?.includes('success'));
			}
		});

		test('working + execution-blocked → selecting (skip + continue)', () => {
			const r = transitionLoop(
				{ kind: 'working', currentItemId: 'i1', status: { kind: 'executing', invocationId: 'inv1' } },
				{ kind: 'execution-blocked', reason: 'needs-credentials' },
			);
			if (r.ok) {
				assert.strictEqual(r.next.kind, 'selecting');
				assert.ok(r.note?.includes('needs-credentials'));
			}
		});

		test('pause from working → paused with resumeWith', () => {
			const r = transitionLoop(
				{ kind: 'working', currentItemId: 'i1', status: { kind: 'executing', invocationId: 'inv1' } },
				{ kind: 'pause' },
			);
			if (r.ok && r.next.kind === 'paused') {
				assert.strictEqual(r.next.resumeWith, 'i1');
			}
		});

		test('pause from selecting → paused with resumeWith=null', () => {
			const r = transitionLoop(selecting, { kind: 'pause' });
			if (r.ok && r.next.kind === 'paused') {
				assert.strictEqual(r.next.resumeWith, null);
			}
		});

		test('pause from idle → refused', () => {
			const r = transitionLoop(idle, { kind: 'pause' });
			assert.strictEqual(r.ok, false);
		});

		test('paused + resume → returns to working when resumeWith set', () => {
			const r = transitionLoop({ kind: 'paused', resumeWith: 'i1' }, { kind: 'resume' });
			if (r.ok && r.next.kind === 'working') {
				assert.strictEqual(r.next.currentItemId, 'i1');
			}
		});

		test('paused + resume with null → selecting', () => {
			const r = transitionLoop({ kind: 'paused', resumeWith: null }, { kind: 'resume' });
			if (r.ok) { assert.strictEqual(r.next.kind, 'selecting'); }
		});

		test('paused + non-resume → refused', () => {
			const r = transitionLoop({ kind: 'paused', resumeWith: null }, { kind: 'start' });
			assert.strictEqual(r.ok, false);
		});

		test('finished is terminal', () => {
			const r = transitionLoop({ kind: 'finished', summary }, { kind: 'start' });
			assert.strictEqual(r.ok, false);
		});
	});

	suite('rankRoadmapItemsForExecution', () => {
		test('drops blocked items', () => {
			const r = rankRoadmapItemsForExecution([
				item({ id: 'a', bucket: 'blocked' }),
				item({ id: 'b', bucket: 'must-finish' }),
			]);
			assert.deepStrictEqual(r.map(i => i.id), ['b']);
		});

		test('orders buckets must-finish < install-and-finish < skeleton-acceptable', () => {
			const r = rankRoadmapItemsForExecution([
				item({ id: 'a', bucket: 'skeleton-acceptable' }),
				item({ id: 'b', bucket: 'install-and-finish' }),
				item({ id: 'c', bucket: 'must-finish' }),
			]);
			assert.deepStrictEqual(r.map(i => i.id), ['c', 'b', 'a']);
		});

		test('intra-bucket: priority ascending, id tie-break', () => {
			const r = rankRoadmapItemsForExecution([
				item({ id: 'z', priority: 100 }),
				item({ id: 'a', priority: 100 }),
				item({ id: 'm', priority: 50 }),
			]);
			assert.deepStrictEqual(r.map(i => i.id), ['m', 'a', 'z']);
		});

		test('empty input', () => {
			assert.deepStrictEqual(rankRoadmapItemsForExecution([]), []);
		});

		test('all-blocked → empty', () => {
			const r = rankRoadmapItemsForExecution([
				item({ id: 'a', bucket: 'blocked' }),
				item({ id: 'b', bucket: 'blocked' }),
			]);
			assert.deepStrictEqual(r, []);
		});
	});

	suite('summarizeLoopOutcomes', () => {
		test('happy mix', () => {
			const r = summarizeLoopOutcomes([
				{ kind: 'completed', outcome: 'success' },
				{ kind: 'completed', outcome: 'success' },
				{ kind: 'completed', outcome: 'failure' },
				{ kind: 'blocked', reason: 'needs-token' },
				{ kind: 'completed', outcome: 'skipped' },
			]);
			assert.deepStrictEqual(r, { closed: 2, skeleton: 0, blocked: 1, skipped: 2 });
		});

		test('non-terminal statuses ignored', () => {
			const r = summarizeLoopOutcomes([
				{ kind: 'open' },
				{ kind: 'in-progress', invocationId: 'x' },
				{ kind: 'completed', outcome: 'success' },
			]);
			assert.strictEqual(r.closed, 1);
		});

		test('empty input', () => {
			const r = summarizeLoopOutcomes([]);
			assert.deepStrictEqual(r, { closed: 0, skeleton: 0, blocked: 0, skipped: 0 });
		});
	});
});
