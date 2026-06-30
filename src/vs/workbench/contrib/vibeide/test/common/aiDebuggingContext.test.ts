/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	buildDebugContextForAgent,
	rankBreakpointsForAgent,
	BreakpointSnapshot,
	DebugSessionSnapshot,
	StackFrameSnapshot,
} from '../../common/aiDebuggingContext.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function bp(overrides: Partial<BreakpointSnapshot> = {}): BreakpointSnapshot {
	return {
		id: 'bp1',
		fileUri: 'file:///x.ts',
		line: 10,
		hitCount: 0,
		enabled: true,
		verified: true,
		...overrides,
	};
}

function frame(overrides: Partial<StackFrameSnapshot> = {}): StackFrameSnapshot {
	return {
		id: 'f1',
		name: 'main',
		variables: [],
		...overrides,
	};
}

function session(overrides: Partial<DebugSessionSnapshot> = {}): DebugSessionSnapshot {
	return {
		sessionId: 'sess-1',
		threadId: 1,
		frames: [],
		...overrides,
	};
}

suite('VibeAIDebuggingService — debug context formatter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildDebugContextForAgent', () => {
		test('renders session heading + thread', () => {
			const r = buildDebugContextForAgent(session());
			assert.ok(r.markdownBody.includes('Debug session sess-1'));
			assert.ok(r.markdownBody.includes('thread 1'));
		});

		test('renders stopped reason when present', () => {
			const r = buildDebugContextForAgent(session({ stoppedReason: 'breakpoint' }));
			assert.ok(r.markdownBody.includes('breakpoint'));
		});

		test('renders active breakpoint location with hits', () => {
			const r = buildDebugContextForAgent(session({
				activeBreakpoint: bp({ line: 42, hitCount: 3, column: 5 }),
			}));
			assert.ok(r.markdownBody.includes('line 42:5'));
			assert.ok(r.markdownBody.includes('hits: 3'));
		});

		test('renders breakpoint condition when set', () => {
			const r = buildDebugContextForAgent(session({
				activeBreakpoint: bp({ condition: 'i > 100' }),
			}));
			assert.ok(r.markdownBody.includes('Condition'));
			assert.ok(r.markdownBody.includes('i > 100'));
		});

		test('omits condition section when empty', () => {
			const r = buildDebugContextForAgent(session({ activeBreakpoint: bp() }));
			assert.ok(!r.markdownBody.includes('Condition'));
		});

		test('renders call stack with file:line', () => {
			const r = buildDebugContextForAgent(session({
				frames: [frame({ name: 'doWork', fileUri: 'file:///y.ts', line: 5 })],
			}));
			assert.ok(r.markdownBody.includes('### Call stack'));
			assert.ok(r.markdownBody.includes('doWork'));
			assert.ok(r.markdownBody.includes('file:///y.ts:5'));
		});

		test('truncates call stack to 10 frames with «…and N more frames»', () => {
			const frames: StackFrameSnapshot[] = [];
			for (let i = 0; i < 15; i++) { frames.push(frame({ id: `f${i}`, name: `frame${i}` })); }
			const r = buildDebugContextForAgent(session({ frames }));
			assert.ok(r.markdownBody.includes('and 5 more frames'));
		});

		test('redacts secret-pattern variable names', () => {
			const r = buildDebugContextForAgent(session({
				frames: [frame({
					variables: [
						{ name: 'apiKey', value: 'sk-secret' },
						{ name: 'API_TOKEN', value: 'abc' },
						{ name: 'normalVar', value: '42' },
					],
				})],
			}));
			assert.ok(r.markdownBody.includes('[REDACTED]'));
			assert.ok(r.markdownBody.includes('normalVar'));
			assert.ok(!r.markdownBody.includes('sk-secret'));
			assert.ok(!r.markdownBody.includes('apiKey: `abc`'));
			assert.ok(r.redactedVariableNames.includes('apiKey'));
			assert.ok(r.redactedVariableNames.includes('API_TOKEN'));
		});

		test('redacts password / bearer / credential / auth patterns', () => {
			const r = buildDebugContextForAgent(session({
				frames: [frame({
					variables: [
						{ name: 'password', value: 'p' },
						{ name: 'bearerToken', value: 'b' },
						{ name: 'authHeader', value: 'a' },
						{ name: 'credential', value: 'c' },
					],
				})],
			}));
			assert.strictEqual(r.redactedVariableNames.length, 4);
		});

		test('truncates variable count to 20 with «…and N more»', () => {
			const variables = Array.from({ length: 30 }, (_, i) => ({ name: `v${i}`, value: 'x' }));
			const r = buildDebugContextForAgent(session({
				frames: [frame({ variables })],
			}));
			assert.ok(r.markdownBody.includes('and 10 more variables'));
		});

		test('truncates long variable values', () => {
			const r = buildDebugContextForAgent(session({
				frames: [frame({
					variables: [{ name: 'big', value: 'a'.repeat(500) }],
				})],
			}));
			const valueLine = r.markdownBody.split('\n').find(l => l.includes('big'));
			assert.ok(valueLine && valueLine.length < 350);
			assert.ok(valueLine && valueLine.includes('…'));
		});

		test('includes type when present', () => {
			const r = buildDebugContextForAgent(session({
				frames: [frame({
					variables: [{ name: 'count', value: '5', type: 'number' }],
				})],
			}));
			assert.ok(r.markdownBody.includes('(number)'));
		});

		test('empty frames → no call stack section', () => {
			const r = buildDebugContextForAgent(session());
			assert.ok(!r.markdownBody.includes('### Call stack'));
		});

		test('redactedVariableNames returned in detection order', () => {
			const r = buildDebugContextForAgent(session({
				frames: [frame({
					variables: [
						{ name: 'normal', value: 'x' },
						{ name: 'apiKey', value: 'y' },
						{ name: 'password', value: 'z' },
					],
				})],
			}));
			assert.deepStrictEqual(r.redactedVariableNames, ['apiKey', 'password']);
		});
	});

	suite('rankBreakpointsForAgent', () => {
		test('many-hits gets high score', () => {
			const r = rankBreakpointsForAgent([
				bp({ id: 'a', hitCount: 50 }),
				bp({ id: 'b', hitCount: 0 }),
			]);
			assert.strictEqual(r[0].id, 'a');
			assert.ok(r[0].reasons.includes('many-hits'));
		});

		test('unverified prioritised', () => {
			const r = rankBreakpointsForAgent([
				bp({ id: 'verified' }),
				bp({ id: 'unverified', verified: false }),
			]);
			assert.strictEqual(r[0].id, 'unverified');
		});

		test('disabled deprioritised', () => {
			const r = rankBreakpointsForAgent([
				bp({ id: 'enabled', hitCount: 5 }),
				bp({ id: 'disabled', hitCount: 50, enabled: false }),
			]);
			assert.strictEqual(r[0].id, 'enabled');
		});

		test('condition adds priority', () => {
			const r = rankBreakpointsForAgent([
				bp({ id: 'a' }),
				bp({ id: 'b', condition: 'x > 0' }),
			]);
			assert.strictEqual(r[0].id, 'b');
			assert.ok(r[0].reasons.includes('has-condition'));
		});

		test('reasons accumulate', () => {
			const r = rankBreakpointsForAgent([
				bp({ id: 'a', hitCount: 50, condition: 'x', verified: false }),
			]);
			assert.ok(r[0].reasons.includes('many-hits'));
			assert.ok(r[0].reasons.includes('has-condition'));
			assert.ok(r[0].reasons.includes('unverified'));
		});

		test('stable id tie-break', () => {
			const r = rankBreakpointsForAgent([
				bp({ id: 'b', hitCount: 0 }),
				bp({ id: 'a', hitCount: 0 }),
			]);
			assert.strictEqual(r[0].id, 'a');
			assert.strictEqual(r[1].id, 'b');
		});

		test('empty input → empty output', () => {
			assert.deepStrictEqual(rankBreakpointsForAgent([]), []);
		});
	});
});
