/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decideSubagentIsolation,
	describeIsolationDecision,
	checkIsolationCapability,
	SubagentIsolationInput,
} from '../../common/subagentIsolationPolicy.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function input(overrides: Partial<SubagentIsolationInput> = {}): SubagentIsolationInput {
	return {
		kind: 'explore',
		hasWorkerSupport: true,
		hasChildProcessSupport: true,
		parentRemainingTokens: 200_000,
		...overrides,
	};
}

suite('Subagent isolation policy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideSubagentIsolation — backend selection', () => {
		test('worker preferred when supported', () => {
			const r = decideSubagentIsolation(input());
			assert.strictEqual(r.backend, 'worker-thread');
		});

		test('child-process when only child-process available', () => {
			const r = decideSubagentIsolation(input({ hasWorkerSupport: false }));
			assert.strictEqual(r.backend, 'child-process');
		});

		test('inline-fallback when no isolation available', () => {
			const r = decideSubagentIsolation(input({
				hasWorkerSupport: false,
				hasChildProcessSupport: false,
			}));
			assert.strictEqual(r.backend, 'inline-fallback');
			assert.ok(r.reasonCodes.includes('no-isolation-available'));
		});

		test('forceInline overrides everything', () => {
			const r = decideSubagentIsolation(input({ forceInline: true }));
			assert.strictEqual(r.backend, 'inline-fallback');
			assert.ok(r.reasonCodes.includes('force-inline'));
		});
	});

	suite('decideSubagentIsolation — quota', () => {
		test('half-of-parent quota with default cap', () => {
			const r = decideSubagentIsolation(input({ parentRemainingTokens: 200_000 }));
			assert.strictEqual(r.contextWindowTokens, 100_000);
		});

		test('caps to maxSubagentTokens', () => {
			const r = decideSubagentIsolation(input({
				parentRemainingTokens: 1_000_000,
				maxSubagentTokens: 50_000,
			}));
			assert.strictEqual(r.contextWindowTokens, 50_000);
		});

		test('floor 1024 + low-budget warning', () => {
			const r = decideSubagentIsolation(input({ parentRemainingTokens: 100 }));
			assert.strictEqual(r.contextWindowTokens, 1024);
			assert.ok(r.reasonCodes.includes('parent-low-budget'));
		});

		test('non-finite maxSubagentTokens falls back to default', () => {
			const r = decideSubagentIsolation(input({
				parentRemainingTokens: 1_000_000,
				maxSubagentTokens: NaN,
			}));
			assert.strictEqual(r.contextWindowTokens, 100_000);
		});
	});

	suite('decideSubagentIsolation — handoff', () => {
		test('explore → task-only (no parent leak)', () => {
			const r = decideSubagentIsolation(input({ kind: 'explore' }));
			assert.strictEqual(r.parentHandoff, 'task-only');
			assert.ok(r.reasonCodes.includes('isolation-strict'));
		});

		test('researcher → task-only', () => {
			const r = decideSubagentIsolation(input({ kind: 'researcher' }));
			assert.strictEqual(r.parentHandoff, 'task-only');
		});

		test('reviewer → full', () => {
			const r = decideSubagentIsolation(input({ kind: 'reviewer' }));
			assert.strictEqual(r.parentHandoff, 'full');
		});

		test('planner → summarised', () => {
			const r = decideSubagentIsolation(input({ kind: 'planner' }));
			assert.strictEqual(r.parentHandoff, 'summarised');
		});

		test('fixer → summarised', () => {
			const r = decideSubagentIsolation(input({ kind: 'fixer' }));
			assert.strictEqual(r.parentHandoff, 'summarised');
		});

		test('custom → summarised (safe default)', () => {
			const r = decideSubagentIsolation(input({ kind: 'custom' }));
			assert.strictEqual(r.parentHandoff, 'summarised');
		});
	});

	suite('decideSubagentIsolation — kill timeout', () => {
		test('per-kind timeouts differ', () => {
			const explore = decideSubagentIsolation(input({ kind: 'explore' })).killTimeoutMs;
			const reviewer = decideSubagentIsolation(input({ kind: 'reviewer' })).killTimeoutMs;
			const fixer = decideSubagentIsolation(input({ kind: 'fixer' })).killTimeoutMs;
			assert.notStrictEqual(explore, reviewer);
			assert.ok(fixer > reviewer);
		});
	});

	suite('describeIsolationDecision', () => {
		test('renders one-line audit trail', () => {
			const dec = decideSubagentIsolation(input());
			const line = describeIsolationDecision(dec, 'explore');
			assert.ok(line.includes('subagent[explore]'));
			assert.ok(line.includes('worker-thread'));
			assert.ok(line.includes('task-only'));
			assert.ok(line.includes('isolation-strict'));
		});

		test('reasons-empty case has no brackets at end', () => {
			// Pick a kind+input where no reason codes accumulate
			const dec = decideSubagentIsolation(input({ kind: 'reviewer' }));
			const line = describeIsolationDecision(dec, 'reviewer');
			assert.ok(!line.endsWith(']'));
		});
	});

	suite('checkIsolationCapability', () => {
		test('worker capable', () => {
			const r = checkIsolationCapability({
				backend: 'worker-thread',
				hasWorkerSupport: true,
				hasChildProcessSupport: false,
			});
			assert.strictEqual(r.capable, true);
		});

		test('worker not capable', () => {
			const r = checkIsolationCapability({
				backend: 'worker-thread',
				hasWorkerSupport: false,
				hasChildProcessSupport: true,
			});
			assert.strictEqual(r.capable, false);
		});

		test('child-process not capable', () => {
			const r = checkIsolationCapability({
				backend: 'child-process',
				hasWorkerSupport: true,
				hasChildProcessSupport: false,
			});
			assert.strictEqual(r.capable, false);
		});

		test('inline-fallback always capable', () => {
			const r = checkIsolationCapability({
				backend: 'inline-fallback',
				hasWorkerSupport: false,
				hasChildProcessSupport: false,
			});
			assert.strictEqual(r.capable, true);
		});
	});
});
