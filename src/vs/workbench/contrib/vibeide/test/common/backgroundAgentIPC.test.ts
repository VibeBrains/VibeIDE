/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decodeInboundEnvelope,
	decodeOutboundEnvelope,
	buildOutboundEnvelope,
	transitionBgAgent,
	runBgAgentScenario,
	BACKGROUND_AGENT_PROTOCOL_VERSION,
	BgAgentState,
} from '../../common/backgroundAgentIPC.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const VALID_CID = 'corr-001';

const env = (overrides: Record<string, unknown> = {}): unknown => ({
	type: 'start',
	version: BACKGROUND_AGENT_PROTOCOL_VERSION,
	correlationId: VALID_CID,
	payload: { x: 1 },
	...overrides,
});

suite('Background agent IPC envelope + lifecycle FSM', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeInboundEnvelope', () => {
		test('happy path', () => {
			const r = decodeInboundEnvelope(env());
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.type, 'start'); }
		});

		test('rejects unknown inbound type', () => {
			const r = decodeInboundEnvelope(env({ type: 'ready' }));
			assert.strictEqual(r.ok, false);
		});

		test('rejects version mismatch', () => {
			const r = decodeInboundEnvelope(env({ version: 99 }));
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.reason.includes('version-mismatch')); }
		});

		test('rejects malformed correlationId', () => {
			const r = decodeInboundEnvelope(env({ correlationId: 'short' }));
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'correlationId-malformed'); }
		});

		test('rejects null', () => {
			assert.strictEqual(decodeInboundEnvelope(null).ok, false);
		});

		test('payload is null when omitted', () => {
			const r = decodeInboundEnvelope(env({ payload: undefined }));
			if (r.ok) { assert.strictEqual(r.value.payload, null); }
		});

		test('all 6 inbound types accepted', () => {
			for (const type of ['start', 'pause', 'resume', 'abort', 'inject-context', 'tick']) {
				assert.strictEqual(decodeInboundEnvelope(env({ type })).ok, true, `type ${type}`);
			}
		});
	});

	suite('decodeOutboundEnvelope', () => {
		test('happy path', () => {
			const r = decodeOutboundEnvelope(env({ type: 'ready' }));
			assert.strictEqual(r.ok, true);
		});

		test('rejects inbound type', () => {
			const r = decodeOutboundEnvelope(env({ type: 'start' }));
			assert.strictEqual(r.ok, false);
		});

		test('all 7 outbound types accepted', () => {
			for (const type of ['ready', 'progress', 'tool-request', 'tool-result', 'log', 'error', 'done']) {
				assert.strictEqual(decodeOutboundEnvelope(env({ type })).ok, true, `type ${type}`);
			}
		});
	});

	suite('buildOutboundEnvelope', () => {
		test('happy path', () => {
			const r = buildOutboundEnvelope('progress', VALID_CID, { steps: 3 });
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.type, 'progress');
				assert.strictEqual(r.value.version, BACKGROUND_AGENT_PROTOCOL_VERSION);
				assert.deepStrictEqual(r.value.payload, { steps: 3 });
			}
		});

		test('rejects inbound type', () => {
			const r = buildOutboundEnvelope('start' as 'progress', VALID_CID, null);
			assert.strictEqual(r.ok, false);
		});

		test('rejects malformed cid', () => {
			const r = buildOutboundEnvelope('progress', 'bad', null);
			assert.strictEqual(r.ok, false);
		});
	});

	suite('transitionBgAgent', () => {
		const idle: BgAgentState = { kind: 'idle' };

		test('idle + start → starting', () => {
			const r = transitionBgAgent(idle, { kind: 'start', nowMs: 1 });
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.next.kind, 'starting');
				if (r.next.kind === 'starting') { assert.strictEqual(r.next.startedAtMs, 1); }
			}
		});

		test('idle + pause → refused', () => {
			const r = transitionBgAgent(idle, { kind: 'pause', nowMs: 1 });
			assert.strictEqual(r.ok, false);
		});

		test('starting + ready → running with stepsCompleted=0', () => {
			const r = transitionBgAgent({ kind: 'starting', startedAtMs: 1 }, { kind: 'ready', nowMs: 2 });
			if (r.ok && r.next.kind === 'running') {
				assert.strictEqual(r.next.stepsCompleted, 0);
				assert.strictEqual(r.next.startedAtMs, 1);
			}
		});

		test('running + progress → updates max stepsCompleted', () => {
			const r1 = transitionBgAgent(
				{ kind: 'running', startedAtMs: 1, stepsCompleted: 5 },
				{ kind: 'progress', stepsCompleted: 7 },
			);
			if (r1.ok && r1.next.kind === 'running') { assert.strictEqual(r1.next.stepsCompleted, 7); }

			// progress with lower stepsCompleted does NOT decrement
			const r2 = transitionBgAgent(
				{ kind: 'running', startedAtMs: 1, stepsCompleted: 5 },
				{ kind: 'progress', stepsCompleted: 3 },
			);
			if (r2.ok && r2.next.kind === 'running') { assert.strictEqual(r2.next.stepsCompleted, 5); }
		});

		test('running + pause → paused', () => {
			const r = transitionBgAgent(
				{ kind: 'running', startedAtMs: 1, stepsCompleted: 3 },
				{ kind: 'pause', nowMs: 2 },
			);
			if (r.ok && r.next.kind === 'paused') {
				assert.strictEqual(r.next.pausedAtMs, 2);
				assert.strictEqual(r.next.stepsCompleted, 3);
			}
		});

		test('paused + resume → running', () => {
			const r = transitionBgAgent(
				{ kind: 'paused', pausedAtMs: 1, stepsCompleted: 3 },
				{ kind: 'resume', nowMs: 2 },
			);
			if (r.ok && r.next.kind === 'running') { assert.strictEqual(r.next.stepsCompleted, 3); }
		});

		test('paused + progress → refused (must resume first)', () => {
			const r = transitionBgAgent(
				{ kind: 'paused', pausedAtMs: 1, stepsCompleted: 3 },
				{ kind: 'progress', stepsCompleted: 5 },
			);
			assert.strictEqual(r.ok, false);
		});

		test('any + abort → aborting', () => {
			const r = transitionBgAgent(
				{ kind: 'running', startedAtMs: 1, stepsCompleted: 0 },
				{ kind: 'abort', reason: 'user-cancel' },
			);
			if (r.ok && r.next.kind === 'aborting') { assert.strictEqual(r.next.abortReason, 'user-cancel'); }
		});

		test('aborting + done → done with outcome=aborted', () => {
			const r = transitionBgAgent(
				{ kind: 'aborting', abortReason: 'x' },
				{ kind: 'done', nowMs: 5, outcome: 'success' },
			);
			if (r.ok && r.next.kind === 'done') { assert.strictEqual(r.next.outcome, 'aborted'); }
		});

		test('running + done → done with reported outcome', () => {
			const r = transitionBgAgent(
				{ kind: 'running', startedAtMs: 1, stepsCompleted: 7 },
				{ kind: 'done', nowMs: 5, outcome: 'success' },
			);
			if (r.ok && r.next.kind === 'done') {
				assert.strictEqual(r.next.outcome, 'success');
				assert.strictEqual(r.next.stepsCompleted, 7);
			}
		});

		test('done + anything → refused (terminal)', () => {
			const r = transitionBgAgent(
				{ kind: 'done', endedAtMs: 1, stepsCompleted: 0, outcome: 'success' },
				{ kind: 'start', nowMs: 2 },
			);
			assert.strictEqual(r.ok, false);
		});
	});

	suite('runBgAgentScenario (driver)', () => {
		test('happy path: start → ready → progress → done', () => {
			const r = runBgAgentScenario({ kind: 'idle' }, [
				{ kind: 'start', nowMs: 1 },
				{ kind: 'ready', nowMs: 2 },
				{ kind: 'progress', stepsCompleted: 5 },
				{ kind: 'done', nowMs: 10, outcome: 'success' },
			]);
			assert.strictEqual(r.final.kind, 'done');
			if (r.final.kind === 'done') {
				assert.strictEqual(r.final.outcome, 'success');
				assert.strictEqual(r.final.stepsCompleted, 5);
			}
			assert.deepStrictEqual(r.refused, []);
		});

		test('refused events recorded but do not advance state', () => {
			const r = runBgAgentScenario({ kind: 'idle' }, [
				{ kind: 'pause', nowMs: 1 },
				{ kind: 'start', nowMs: 2 },
			]);
			assert.strictEqual(r.refused.length, 1);
			assert.strictEqual(r.refused[0].attemptedFrom, 'idle');
			assert.strictEqual(r.refused[0].attemptedEvent, 'pause');
			assert.strictEqual(r.final.kind, 'starting');
		});

		test('pause-resume cycle preserves stepsCompleted', () => {
			const r = runBgAgentScenario({ kind: 'idle' }, [
				{ kind: 'start', nowMs: 1 },
				{ kind: 'ready', nowMs: 2 },
				{ kind: 'progress', stepsCompleted: 3 },
				{ kind: 'pause', nowMs: 4 },
				{ kind: 'resume', nowMs: 5 },
				{ kind: 'progress', stepsCompleted: 7 },
			]);
			if (r.final.kind === 'running') { assert.strictEqual(r.final.stepsCompleted, 7); }
		});
	});
});
