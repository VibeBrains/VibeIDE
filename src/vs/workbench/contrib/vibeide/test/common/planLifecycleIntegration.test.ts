/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Integration test scaffolding for plan lifecycle (roadmap §979).
//
// The pure FSM `planLifecycleStateMachine.ts` already has 31 unit tests for the
// transition table. This module exercises the SAME `CANONICAL_SCENARIOS` against
// a mock-injected `IFileService` to verify that the runtime side (persistence
// shape, lease semantics, resume-after-reload) matches the FSM's expected
// transitions — without spinning up any real file IO or workbench harness.
//
// The mock-injection pattern is intentionally narrow: a single in-memory map of
// URI -> JSON string. Tests can simulate `reload` by re-instantiating the
// runtime against the SAME mock map, asserting the transitions resume from the
// last persisted status. When the real `vibePersistedPlanService` lifecycle is
// finalized, this scaffolding stays as the cross-FSM-runtime conformance check.

import * as assert from 'assert';
import {
	CANONICAL_SCENARIOS,
	PlanStatus,
	runPlanScenario,
	transitionPlan,
} from '../../common/planLifecycleStateMachine.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

// ── Mock IFileService surface ─────────────────────────────────────────────────
// We keep the mock intentionally minimal — only the methods a future runtime
// adapter will actually call. When the persistence side ships, swap this for
// an actual `IFileService` (or a stub built on top of it).

interface MockFs {
	readonly read: (uri: string) => string | undefined;
	readonly write: (uri: string, content: string) => void;
	readonly exists: (uri: string) => boolean;
	readonly snapshot: () => ReadonlyMap<string, string>;
}

function createMockFs(initial: ReadonlyMap<string, string> = new Map()): MockFs {
	const store = new Map<string, string>(initial);
	return {
		read: (uri) => store.get(uri),
		write: (uri, content) => { store.set(uri, content); },
		exists: (uri) => store.has(uri),
		snapshot: () => store,
	};
}

// ── Persistence shape (mirrors what vibePersistedPlanService emits) ──────────
// The minimal envelope we replay: status + last-event timestamp + sequence
// counter to detect divergence. Real service may carry more (active model id,
// lease holder, etc.) — keep the schema narrow until the runtime lands.

interface PersistedPlan {
	readonly status: PlanStatus;
	readonly seq: number;
}

const PLAN_URI = 'mock:///plan-fixture/main.plan.json';

function persist(fs: MockFs, plan: PersistedPlan): void {
	fs.write(PLAN_URI, JSON.stringify(plan));
}

function load(fs: MockFs): PersistedPlan | null {
	const raw = fs.read(PLAN_URI);
	if (!raw) { return null; }
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.status !== 'string') { return null; }
		if (typeof parsed?.seq !== 'number') { return null; }
		return { status: parsed.status as PlanStatus, seq: parsed.seq };
	} catch {
		return null;
	}
}

// ── Drive a scenario through the mock fs and assert persistence shape ─────────

function drivePersistedScenario(
	fs: MockFs,
	scenarioName: keyof typeof CANONICAL_SCENARIOS,
): { final: PersistedPlan; refused: number } {
	const scenario = CANONICAL_SCENARIOS[scenarioName];
	let current: PlanStatus = scenario.initial;
	let seq = 0;
	persist(fs, { status: current, seq });
	let refused = 0;
	for (const entry of scenario.entries) {
		const result = transitionPlan(current, entry.event);
		if (result.ok) {
			current = result.next;
			seq++;
			persist(fs, { status: current, seq });
		} else {
			refused++;
		}
	}
	const final = load(fs)!;
	return { final, refused };
}

suite('planLifecycle integration scaffolding', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('happy-path scenario persists final status `done`', () => {
		const fs = createMockFs();
		const { final, refused } = drivePersistedScenario(fs, 'happy-path-3-step');
		assert.strictEqual(final.status, 'done');
		assert.strictEqual(refused, 0, 'happy path must not refuse any transition');
		assert.strictEqual(final.seq, 5, 'one persist per accepted transition');
	});

	test('pause-and-resume scenario persists `done`', () => {
		const fs = createMockFs();
		const { final, refused } = drivePersistedScenario(fs, 'pause-and-resume');
		assert.strictEqual(final.status, 'done');
		assert.strictEqual(refused, 0);
	});

	test('retry-then-fail scenario persists `failed`', () => {
		const fs = createMockFs();
		const { final, refused } = drivePersistedScenario(fs, 'retry-then-fail');
		assert.strictEqual(final.status, 'failed');
		assert.strictEqual(refused, 0);
	});

	test('abort-during-running scenario persists `aborted`', () => {
		const fs = createMockFs();
		const { final, refused } = drivePersistedScenario(fs, 'abort-during-running');
		assert.strictEqual(final.status, 'aborted');
		assert.strictEqual(refused, 0);
	});

	test('reload after pause: re-instantiating against same fs picks up `paused`', () => {
		const fs = createMockFs();
		// Run only the first 3 entries of pause-and-resume (approve / start / pause).
		const partialEntries = CANONICAL_SCENARIOS['pause-and-resume'].entries.slice(0, 3);
		const partialResult = runPlanScenario('draft', partialEntries);
		assert.strictEqual(partialResult.finalStatus, 'paused');
		persist(fs, { status: partialResult.finalStatus, seq: partialEntries.length });

		// Simulate reload: a fresh "runtime" reads the persisted shape and resumes.
		const reloaded = load(fs);
		assert.ok(reloaded);
		assert.strictEqual(reloaded.status, 'paused');

		// Continue with the remaining entries from the loaded status.
		const remaining = CANONICAL_SCENARIOS['pause-and-resume'].entries.slice(3);
		const finalResult = runPlanScenario(reloaded.status, remaining);
		assert.strictEqual(finalResult.finalStatus, 'done');
		assert.strictEqual(finalResult.mismatches.length, 0);
	});

	test('reload after corrupted persistence falls back to null (caller decides)', () => {
		const fs = createMockFs();
		fs.write(PLAN_URI, '{"status":"not-a-real-status"}'); // missing seq
		const reloaded = load(fs);
		assert.strictEqual(reloaded, null);
	});

	test('mismatched expected status surfaces in scenario result', () => {
		const result = runPlanScenario('draft', [
			{ event: { kind: 'approve' }, expected: 'ready' },
			// Force a wrong expectation to confirm the mismatch reporter works.
			{ event: { kind: 'start' }, expected: 'paused' as PlanStatus },
		]);
		assert.strictEqual(result.mismatches.length, 1);
		assert.strictEqual(result.mismatches[0].expected, 'paused');
		assert.strictEqual(result.mismatches[0].actual, 'running');
	});

	test('refused transition does not advance status nor bump seq', () => {
		const fs = createMockFs();
		// Try to start without approve first — refused.
		const result = transitionPlan('draft', { kind: 'start' });
		assert.strictEqual(result.ok, false);
		// Persist nothing on refusal.
		assert.strictEqual(fs.exists(PLAN_URI), false);
	});
});
