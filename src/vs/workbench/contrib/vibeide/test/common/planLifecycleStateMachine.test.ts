/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	transitionPlan,
	isTerminalState,
	runPlanScenario,
	CANONICAL_SCENARIOS,
	PlanStatus,
} from '../../common/planLifecycleStateMachine.js';

suite('planLifecycleStateMachine', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('isTerminalState', () => {
		test('done / failed / aborted are terminal', () => {
			assert.strictEqual(isTerminalState('done'), true);
			assert.strictEqual(isTerminalState('failed'), true);
			assert.strictEqual(isTerminalState('aborted'), true);
		});

		test('non-terminal states', () => {
			for (const s of ['draft', 'ready', 'running', 'paused'] as PlanStatus[]) {
				assert.strictEqual(isTerminalState(s), false);
			}
		});
	});

	suite('transitionPlan — valid edges', () => {
		test('draft + approve → ready', () => {
			const r = transitionPlan('draft', { kind: 'approve' });
			assert.ok(r.ok && r.next === 'ready');
		});

		test('ready + start → running', () => {
			const r = transitionPlan('ready', { kind: 'start' });
			assert.ok(r.ok && r.next === 'running');
		});

		test('ready + approve → ready (idempotent)', () => {
			const r = transitionPlan('ready', { kind: 'approve' });
			assert.ok(r.ok && r.next === 'ready');
			if (r.ok) { assert.strictEqual(r.note, 'idempotent-approve'); }
		});

		test('running + step-completed (remaining > 0) → running with note', () => {
			const r = transitionPlan('running', { kind: 'step-completed', remaining: 2 });
			assert.ok(r.ok && r.next === 'running');
			if (r.ok) { assert.strictEqual(r.note, 'step advanced'); }
		});

		test('running + step-completed (remaining 0) → done', () => {
			const r = transitionPlan('running', { kind: 'step-completed', remaining: 0 });
			assert.ok(r.ok && r.next === 'done');
		});

		test('running + step-failed (retries exhausted) → failed', () => {
			const r = transitionPlan('running', { kind: 'step-failed', retriesExhausted: true });
			assert.ok(r.ok && r.next === 'failed');
		});

		test('running + step-failed (retries available) → running with note', () => {
			const r = transitionPlan('running', { kind: 'step-failed', retriesExhausted: false });
			assert.ok(r.ok && r.next === 'running');
			if (r.ok) { assert.strictEqual(r.note, 'retry pending'); }
		});

		test('running + pause → paused', () => {
			const r = transitionPlan('running', { kind: 'pause' });
			assert.ok(r.ok && r.next === 'paused');
		});

		test('paused + resume → running', () => {
			const r = transitionPlan('paused', { kind: 'resume' });
			assert.ok(r.ok && r.next === 'running');
		});

		test('paused + step-completed → paused with background-catchup note', () => {
			const r = transitionPlan('paused', { kind: 'step-completed', remaining: 1 });
			assert.ok(r.ok && r.next === 'paused');
			if (r.ok) { assert.strictEqual(r.note, 'background catch-up; remain paused'); }
		});
	});

	suite('transitionPlan — abort handling', () => {
		test('abort allowed from non-terminal states', () => {
			for (const s of ['draft', 'ready', 'running', 'paused'] as PlanStatus[]) {
				const r = transitionPlan(s, { kind: 'abort' });
				assert.ok(r.ok && r.next === 'aborted', `abort failed from ${s}`);
			}
		});

		test('abort refused from terminal states', () => {
			for (const s of ['done', 'failed', 'aborted'] as PlanStatus[]) {
				const r = transitionPlan(s, { kind: 'abort' });
				assert.strictEqual(r.ok, false, `abort accepted from terminal ${s}`);
			}
		});
	});

	suite('transitionPlan — invalid edges', () => {
		test('draft + start → refused (must approve first)', () => {
			const r = transitionPlan('draft', { kind: 'start' });
			assert.strictEqual(r.ok, false);
			if (!r.ok) {
				assert.strictEqual(r.reason, 'invalid-from-status');
				assert.strictEqual(r.attemptedFrom, 'draft');
				assert.strictEqual(r.attemptedEvent, 'start');
			}
		});

		test('ready + step-completed → refused (must start first)', () => {
			const r = transitionPlan('ready', { kind: 'step-completed', remaining: 0 });
			assert.strictEqual(r.ok, false);
		});

		test('running + approve → refused', () => {
			const r = transitionPlan('running', { kind: 'approve' });
			assert.strictEqual(r.ok, false);
		});

		test('done + start → refused (terminal)', () => {
			const r = transitionPlan('done', { kind: 'start' });
			assert.strictEqual(r.ok, false);
		});

		test('paused + start → refused (use resume)', () => {
			const r = transitionPlan('paused', { kind: 'start' });
			assert.strictEqual(r.ok, false);
		});

		test('running + step-completed with negative remaining → refused', () => {
			const r = transitionPlan('running', { kind: 'step-completed', remaining: -1 });
			assert.strictEqual(r.ok, false);
		});
	});

	suite('runPlanScenario', () => {
		test('happy path: draft → done', () => {
			const r = runPlanScenario('draft', [
				{ event: { kind: 'approve' }, expected: 'ready' },
				{ event: { kind: 'start' }, expected: 'running' },
				{ event: { kind: 'step-completed', remaining: 0 }, expected: 'done' },
			]);
			assert.strictEqual(r.finalStatus, 'done');
			assert.strictEqual(r.mismatches.length, 0);
			assert.strictEqual(r.transitions.length, 3);
		});

		test('refused event keeps from-status — does not advance', () => {
			const r = runPlanScenario('draft', [
				{ event: { kind: 'start' } },               // refused (must approve)
				{ event: { kind: 'approve' }, expected: 'ready' },
			]);
			assert.strictEqual(r.finalStatus, 'ready');
			assert.strictEqual(r.transitions[0].result.ok, false);
		});

		test('mismatch recorded when actual differs from expected', () => {
			const r = runPlanScenario('draft', [
				{ event: { kind: 'approve' }, expected: 'running' },  // wrong: should be 'ready'
			]);
			assert.strictEqual(r.mismatches.length, 1);
			assert.strictEqual(r.mismatches[0].expected, 'running');
			assert.strictEqual(r.mismatches[0].actual, 'ready');
		});

		test('mismatch reports "refused" when transition rejected', () => {
			const r = runPlanScenario('draft', [
				{ event: { kind: 'start' }, expected: 'running' },  // refused
			]);
			assert.strictEqual(r.mismatches[0].actual, 'refused');
		});

		test('entries without `expected` skip mismatch tracking', () => {
			const r = runPlanScenario('draft', [
				{ event: { kind: 'approve' } },
				{ event: { kind: 'start' } },
			]);
			assert.strictEqual(r.mismatches.length, 0);
			assert.strictEqual(r.finalStatus, 'running');
		});
	});

	suite('CANONICAL_SCENARIOS', () => {
		test('happy-path-3-step: 5 events, ends in done', () => {
			const s = CANONICAL_SCENARIOS['happy-path-3-step'];
			const r = runPlanScenario(s.initial, s.entries);
			assert.strictEqual(r.finalStatus, 'done');
			assert.strictEqual(r.mismatches.length, 0);
		});

		test('pause-and-resume: ends in done after pause/resume cycle', () => {
			const s = CANONICAL_SCENARIOS['pause-and-resume'];
			const r = runPlanScenario(s.initial, s.entries);
			assert.strictEqual(r.finalStatus, 'done');
			assert.strictEqual(r.mismatches.length, 0);
		});

		test('retry-then-fail: ends in failed after retry exhausted', () => {
			const s = CANONICAL_SCENARIOS['retry-then-fail'];
			const r = runPlanScenario(s.initial, s.entries);
			assert.strictEqual(r.finalStatus, 'failed');
			assert.strictEqual(r.mismatches.length, 0);
		});

		test('abort-during-running: ends in aborted', () => {
			const s = CANONICAL_SCENARIOS['abort-during-running'];
			const r = runPlanScenario(s.initial, s.entries);
			assert.strictEqual(r.finalStatus, 'aborted');
			assert.strictEqual(r.mismatches.length, 0);
		});

		test('canonical scenarios cover every state', () => {
			const seen = new Set<PlanStatus>();
			for (const name of Object.keys(CANONICAL_SCENARIOS)) {
				const s = CANONICAL_SCENARIOS[name];
				seen.add(s.initial);
				const r = runPlanScenario(s.initial, s.entries);
				seen.add(r.finalStatus);
				for (const t of r.transitions) {
					seen.add(t.from);
					if (t.result.ok) { seen.add(t.result.next); }
				}
			}
			// All non-terminal states must be exercised; terminal includes done/failed/aborted.
			const requiredStates: PlanStatus[] = ['draft', 'ready', 'running', 'paused', 'done', 'failed', 'aborted'];
			for (const s of requiredStates) {
				assert.ok(seen.has(s), `state ${s} not exercised by canonical scenarios`);
			}
		});
	});
});
