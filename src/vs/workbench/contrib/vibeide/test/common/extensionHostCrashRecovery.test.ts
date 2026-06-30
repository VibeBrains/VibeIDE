/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideEHCrashRecovery,
	describeEHCrashRecovery,
	EHRecoveryInput,
} from '../../common/extensionHostCrashRecovery.js';

const baseInput: EHRecoveryInput = {
	phase: 'idle',
	lastCheckpointAgeMs: null,
	plan: null,
	crashKind: 'extension-host-disconnect',
};

suite('extensionHostCrashRecovery', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideEHCrashRecovery', () => {
		test('idle at crash → silent', () => {
			const r = decideEHCrashRecovery(baseInput);
			assert.strictEqual(r.action, 'silent');
			if (r.action === 'silent') { assert.strictEqual(r.reason, 'idle-at-crash'); }
		});

		test('plan-executing wins over everything → integrate-plan-resume', () => {
			const r = decideEHCrashRecovery({
				...baseInput,
				phase: 'plan-executing',
				plan: { planId: 'p1', lastCompletedStepIdx: 2, totalSteps: 5 },
			});
			assert.strictEqual(r.action, 'integrate-plan-resume');
			if (r.action === 'integrate-plan-resume') {
				assert.strictEqual(r.planId, 'p1');
				assert.strictEqual(r.lastCompletedStepIdx, 2);
			}
		});

		test('plan-executing without plan handle falls through to idle/streaming branch', () => {
			// Defensive: phase is set but plan ref is missing — shouldn't crash.
			const r = decideEHCrashRecovery({ ...baseInput, phase: 'plan-executing', plan: null });
			// Falls through; with phase != idle and != tool-running, lands on streaming branch.
			assert.strictEqual(r.action, 'pause-and-prompt-resume');
		});

		test('tool-running without checkpoint → force-discard-with-warning', () => {
			const r = decideEHCrashRecovery({
				...baseInput,
				phase: 'tool-running',
				lastCheckpointAgeMs: null,
			});
			assert.strictEqual(r.action, 'force-discard-with-warning');
			if (r.action === 'force-discard-with-warning') {
				assert.strictEqual(r.reason, 'tool-running-no-checkpoint');
				assert.strictEqual(r.checkpointAgeMs, null);
			}
		});

		test('tool-running with old checkpoint → force-discard-with-warning', () => {
			const r = decideEHCrashRecovery({
				...baseInput,
				phase: 'tool-running',
				lastCheckpointAgeMs: 60 * 60 * 1000,  // 1h, > default 30m
			});
			assert.strictEqual(r.action, 'force-discard-with-warning');
			if (r.action === 'force-discard-with-warning') {
				assert.strictEqual(r.reason, 'checkpoint-too-old');
				assert.strictEqual(r.checkpointAgeMs, 60 * 60 * 1000);
			}
		});

		test('tool-running with fresh checkpoint → pause-and-prompt-resume', () => {
			const r = decideEHCrashRecovery({
				...baseInput,
				phase: 'tool-running',
				lastCheckpointAgeMs: 5 * 60 * 1000,  // 5m
			});
			assert.strictEqual(r.action, 'pause-and-prompt-resume');
			if (r.action === 'pause-and-prompt-resume') {
				assert.strictEqual(r.reason, 'tool-running-with-checkpoint');
				assert.strictEqual(r.checkpointAgeMs, 5 * 60 * 1000);
			}
		});

		test('streaming-llm always → pause-and-prompt-resume regardless of checkpoint', () => {
			const noCp = decideEHCrashRecovery({ ...baseInput, phase: 'streaming-llm' });
			assert.strictEqual(noCp.action, 'pause-and-prompt-resume');
			if (noCp.action === 'pause-and-prompt-resume') { assert.strictEqual(noCp.reason, 'streaming-interrupted'); }

			const withCp = decideEHCrashRecovery({
				...baseInput,
				phase: 'streaming-llm',
				lastCheckpointAgeMs: 12_000,
			});
			assert.strictEqual(withCp.action, 'pause-and-prompt-resume');
		});

		test('checkpoint exactly at maxAge boundary is still resumable (strict greater-than check)', () => {
			const r = decideEHCrashRecovery({
				...baseInput,
				phase: 'tool-running',
				lastCheckpointAgeMs: 30 * 60 * 1000,  // exactly 30m
			});
			assert.strictEqual(r.action, 'pause-and-prompt-resume');
		});

		test('custom maxCheckpointAgeMs honored', () => {
			const r = decideEHCrashRecovery({
				...baseInput,
				phase: 'tool-running',
				lastCheckpointAgeMs: 2 * 60 * 1000,  // 2m
				maxCheckpointAgeMs: 60 * 1000,        // 1m budget — too old
			});
			assert.strictEqual(r.action, 'force-discard-with-warning');
		});

		test('crashKind is passed-through but does not affect action choice in v1', () => {
			const a = decideEHCrashRecovery({ ...baseInput, phase: 'streaming-llm', crashKind: 'extension-host-disconnect' });
			const b = decideEHCrashRecovery({ ...baseInput, phase: 'streaming-llm', crashKind: 'process-exit' });
			const c = decideEHCrashRecovery({ ...baseInput, phase: 'streaming-llm', crashKind: 'window-close-while-running' });
			assert.strictEqual(a.action, b.action);
			assert.strictEqual(b.action, c.action);
		});
	});

	suite('describeEHCrashRecovery', () => {
		test('silent → empty banner (caller suppresses)', () => {
			const r = decideEHCrashRecovery(baseInput);
			assert.strictEqual(describeEHCrashRecovery(r), '');
		});

		test('integrate-plan-resume → mentions step number 1-indexed', () => {
			const r = decideEHCrashRecovery({
				...baseInput,
				phase: 'plan-executing',
				plan: { planId: 'P-42', lastCompletedStepIdx: 2, totalSteps: 5 },
			});
			const text = describeEHCrashRecovery(r);
			assert.match(text, /шага 3/);
			assert.match(text, /P-42/);
		});

		test('tool-running force-discard mentions git status', () => {
			const r = decideEHCrashRecovery({ ...baseInput, phase: 'tool-running', lastCheckpointAgeMs: null });
			const text = describeEHCrashRecovery(r);
			assert.match(text, /git status/);
		});

		test('age formatter produces sensible suffixes', () => {
			const fresh = decideEHCrashRecovery({ ...baseInput, phase: 'tool-running', lastCheckpointAgeMs: 5_000 });
			assert.match(describeEHCrashRecovery(fresh), /5s/);

			const minutes = decideEHCrashRecovery({ ...baseInput, phase: 'tool-running', lastCheckpointAgeMs: 5 * 60_000 });
			assert.match(describeEHCrashRecovery(minutes), /5m/);

			const hours = decideEHCrashRecovery({ ...baseInput, phase: 'tool-running', lastCheckpointAgeMs: 50 * 60_000, maxCheckpointAgeMs: 60_000 });
			assert.match(describeEHCrashRecovery(hours), /50m/);
		});
	});
});
