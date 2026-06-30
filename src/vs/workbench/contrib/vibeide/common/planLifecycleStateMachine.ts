/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Persisted-plan lifecycle state machine + scenario DSL (pure helper).
 *
 * L.0 line 982 asks for an integration test covering the full plan lifecycle
 * (create → approve → execute → resume after reload → complete). A real
 * integration test needs IFileService, the chat thread runtime, and a multi-
 * window setup — that's blocked work. But the state-machine portion is pure:
 * given a current plan status and an event, decide the next status (or refuse).
 *
 * This module is the single source of truth for plan transitions. Adoption:
 *   - VibePersistedPlanService consults `transitionPlan(current, event)` before
 *     writing a status update; refuses with a clear `reason` on invalid edges.
 *   - Audit log records (oldStatus → newStatus, event, reason?).
 *   - Integration tests use `runPlanScenario` to drive a sequence of events
 *     and assert the full transition history matches an expected log. When the
 *     real integration tests land, the scenario DSL is the deterministic part;
 *     the IO is mocked.
 *
 * vscode-free.
 */

export type PlanStatus = 'draft' | 'ready' | 'running' | 'paused' | 'done' | 'failed' | 'aborted';

export type PlanEvent =
	| { readonly kind: 'approve' }
	| { readonly kind: 'start' }
	| { readonly kind: 'step-completed'; readonly remaining: number }
	| { readonly kind: 'step-failed'; readonly retriesExhausted: boolean }
	| { readonly kind: 'pause' }
	| { readonly kind: 'resume' }
	| { readonly kind: 'abort' };

export type TransitionRefusalReason =
	| 'invalid-from-status'
	| 'all-steps-done-but-event-was-not-step-completed'
	| 'unknown-event-kind';

export type TransitionResult =
	| { readonly ok: true; readonly next: PlanStatus; readonly note?: string }
	| { readonly ok: false; readonly reason: TransitionRefusalReason; readonly attemptedFrom: PlanStatus; readonly attemptedEvent: PlanEvent['kind'] };

const TERMINAL_STATES: ReadonlySet<PlanStatus> = new Set(['done', 'failed', 'aborted']);

/**
 * Pure: returns true iff the status cannot transition further (the plan is
 * settled). Useful for cleanup / lease release decisions.
 */
export function isTerminalState(status: PlanStatus): boolean {
	return TERMINAL_STATES.has(status);
}

/**
 * Pure: applies an event to a plan status. Refuses on invalid edges with a
 * tagged result; never throws.
 *
 * Transition table (unmatched (from, event) returns `invalid-from-status`):
 *
 *   draft   + approve      → ready
 *   ready   + start        → running
 *   running + step-completed (remaining > 0)  → running (note: 'step advanced')
 *   running + step-completed (remaining === 0) → done
 *   running + step-failed (retriesExhausted)  → failed
 *   running + step-failed (!retriesExhausted) → running (note: 'retry pending')
 *   running + pause        → paused
 *   paused  + resume       → running
 *   paused  + step-completed → paused (note: 'background catch-up; remain paused')
 *   ANY non-terminal + abort → aborted
 *
 * Note on `step-completed` with `remaining === 0`: explicit "you finished all
 * steps" event. Callers that don't track remaining themselves should compute it
 * before calling.
 */
export function transitionPlan(from: PlanStatus, event: PlanEvent): TransitionResult {
	if (event.kind === 'abort') {
		if (TERMINAL_STATES.has(from)) {
			return { ok: false, reason: 'invalid-from-status', attemptedFrom: from, attemptedEvent: 'abort' };
		}
		return { ok: true, next: 'aborted' };
	}

	switch (from) {
		case 'draft':
			if (event.kind === 'approve') { return { ok: true, next: 'ready' }; }
			break;

		case 'ready':
			if (event.kind === 'start') { return { ok: true, next: 'running' }; }
			// Re-approving a ready plan is a no-op (idempotent).
			if (event.kind === 'approve') { return { ok: true, next: 'ready', note: 'idempotent-approve' }; }
			break;

		case 'running':
			if (event.kind === 'step-completed') {
				if (event.remaining < 0) {
					return { ok: false, reason: 'invalid-from-status', attemptedFrom: from, attemptedEvent: 'step-completed' };
				}
				return event.remaining === 0
					? { ok: true, next: 'done' }
					: { ok: true, next: 'running', note: 'step advanced' };
			}
			if (event.kind === 'step-failed') {
				return event.retriesExhausted
					? { ok: true, next: 'failed' }
					: { ok: true, next: 'running', note: 'retry pending' };
			}
			if (event.kind === 'pause') { return { ok: true, next: 'paused' }; }
			break;

		case 'paused':
			if (event.kind === 'resume') { return { ok: true, next: 'running' }; }
			// step-completed in paused = background runner finished a queued step
			// but UI is still showing paused; stay paused. The runtime decides
			// whether to surface a notification.
			if (event.kind === 'step-completed') { return { ok: true, next: 'paused', note: 'background catch-up; remain paused' }; }
			break;

		case 'done':
		case 'failed':
		case 'aborted':
			// Terminal — no further transitions. Note: 'abort' is handled above
			// and returns refusal in the terminal branch.
			break;
	}

	return { ok: false, reason: 'invalid-from-status', attemptedFrom: from, attemptedEvent: event.kind };
}

export interface ScenarioEntry {
	readonly event: PlanEvent;
	readonly expected?: PlanStatus;
	readonly note?: string;
}

export interface ScenarioRunResult {
	readonly finalStatus: PlanStatus;
	readonly transitions: ReadonlyArray<{
		readonly from: PlanStatus;
		readonly event: PlanEvent['kind'];
		readonly result: TransitionResult;
	}>;
	readonly mismatches: ReadonlyArray<{
		readonly stepIdx: number;
		readonly expected: PlanStatus;
		readonly actual: PlanStatus | 'refused';
	}>;
}

/**
 * Pure: runs a sequence of events through `transitionPlan`, capturing the full
 * transition log + any mismatches between an entry's `expected` status and the
 * actual result. Use to assert lifecycle conformance in integration tests
 * without spinning up any IO.
 *
 * On refusal: the transition is recorded but `from` does NOT advance — the
 * scenario continues from the same status, simulating the runtime's behaviour
 * (refused transitions don't change persisted state).
 */
export function runPlanScenario(initial: PlanStatus, entries: readonly ScenarioEntry[]): ScenarioRunResult {
	const transitions: { from: PlanStatus; event: PlanEvent['kind']; result: TransitionResult }[] = [];
	const mismatches: { stepIdx: number; expected: PlanStatus; actual: PlanStatus | 'refused' }[] = [];
	let current: PlanStatus = initial;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const result = transitionPlan(current, entry.event);
		transitions.push({ from: current, event: entry.event.kind, result });
		const actual: PlanStatus | 'refused' = result.ok ? result.next : 'refused';
		if (entry.expected !== undefined && actual !== entry.expected) {
			mismatches.push({ stepIdx: i, expected: entry.expected, actual });
		}
		if (result.ok) {
			current = result.next;
		}
	}
	return { finalStatus: current, transitions, mismatches };
}

/**
 * Pure: pre-built scenarios for integration test scaffolding. Each one is
 * asserted by the test file `planLifecycleStateMachine.test.ts`. Using the
 * canonical scenarios in real integration tests guarantees they exercise the
 * same paths the unit tests cover.
 */
export const CANONICAL_SCENARIOS: Readonly<Record<string, { readonly initial: PlanStatus; readonly entries: readonly ScenarioEntry[] }>> = Object.freeze({
	'happy-path-3-step': {
		initial: 'draft',
		entries: [
			{ event: { kind: 'approve' }, expected: 'ready' },
			{ event: { kind: 'start' }, expected: 'running' },
			{ event: { kind: 'step-completed', remaining: 2 }, expected: 'running' },
			{ event: { kind: 'step-completed', remaining: 1 }, expected: 'running' },
			{ event: { kind: 'step-completed', remaining: 0 }, expected: 'done' },
		],
	},
	'pause-and-resume': {
		initial: 'draft',
		entries: [
			{ event: { kind: 'approve' }, expected: 'ready' },
			{ event: { kind: 'start' }, expected: 'running' },
			{ event: { kind: 'pause' }, expected: 'paused' },
			{ event: { kind: 'resume' }, expected: 'running' },
			{ event: { kind: 'step-completed', remaining: 0 }, expected: 'done' },
		],
	},
	'retry-then-fail': {
		initial: 'draft',
		entries: [
			{ event: { kind: 'approve' }, expected: 'ready' },
			{ event: { kind: 'start' }, expected: 'running' },
			{ event: { kind: 'step-failed', retriesExhausted: false }, expected: 'running' },
			{ event: { kind: 'step-failed', retriesExhausted: true }, expected: 'failed' },
		],
	},
	'abort-during-running': {
		initial: 'draft',
		entries: [
			{ event: { kind: 'approve' }, expected: 'ready' },
			{ event: { kind: 'start' }, expected: 'running' },
			{ event: { kind: 'abort' }, expected: 'aborted' },
		],
	},
});
