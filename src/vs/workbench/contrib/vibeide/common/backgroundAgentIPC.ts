/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Background agent — IPC envelope decoder + lifecycle FSM
 * (roadmap §"Real-impl tail / Phase 3b — Background agent — реальный IPC
 * executor для `vibe-agent-run.js`. Сейчас design doc + skeleton; без
 * executor unattended runner физически не работает").
 *
 * Pure helpers — `vscode`-free. The IDE side and the spawned `vibe-agent-run.js`
 * exchange JSON line-delimited messages over a socket / stdin / IPC channel.
 * This module:
 *   - decodes the wire envelope (`{type, version, payload}`) and refuses
 *     unknown shapes
 *   - drives the runner lifecycle FSM (idle → running → paused/aborted/done)
 *   - validates outbound payloads before send
 *
 * Real fork/spawn lives in `browser/`; this module is the contract.
 */

export const BACKGROUND_AGENT_PROTOCOL_VERSION = 1;

export type BgAgentInboundType =
	| 'start'
	| 'pause'
	| 'resume'
	| 'abort'
	| 'inject-context'
	| 'tick';

export type BgAgentOutboundType =
	| 'ready'
	| 'progress'
	| 'tool-request'
	| 'tool-result'
	| 'log'
	| 'error'
	| 'done';

export interface BgAgentEnvelope<TType extends string, TPayload = unknown> {
	readonly type: TType;
	readonly version: number;
	readonly correlationId: string;
	readonly payload: TPayload;
}

export type DecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

const CORRELATION_ID_PATTERN = /^[a-zA-Z0-9._-]{8,128}$/;

const INBOUND_TYPES: ReadonlySet<BgAgentInboundType> = new Set([
	'start', 'pause', 'resume', 'abort', 'inject-context', 'tick',
]);
const OUTBOUND_TYPES: ReadonlySet<BgAgentOutboundType> = new Set([
	'ready', 'progress', 'tool-request', 'tool-result', 'log', 'error', 'done',
]);

/**
 * Decode an inbound envelope (IDE → runner). Refuses unknown types,
 * mismatched versions, malformed correlation ids. Payload validation
 * is left to the per-type decoder so this stays small.
 */
export function decodeInboundEnvelope(raw: unknown): DecodeResult<BgAgentEnvelope<BgAgentInboundType>> {
	const generic = decodeGenericEnvelope(raw);
	if (!generic.ok) { return generic; }
	if (!INBOUND_TYPES.has(generic.value.type as BgAgentInboundType)) {
		return { ok: false, reason: `type-not-inbound:${generic.value.type}` };
	}
	return { ok: true, value: generic.value as BgAgentEnvelope<BgAgentInboundType> };
}

/**
 * Decode an outbound envelope (runner → IDE). Same validation.
 */
export function decodeOutboundEnvelope(raw: unknown): DecodeResult<BgAgentEnvelope<BgAgentOutboundType>> {
	const generic = decodeGenericEnvelope(raw);
	if (!generic.ok) { return generic; }
	if (!OUTBOUND_TYPES.has(generic.value.type as BgAgentOutboundType)) {
		return { ok: false, reason: `type-not-outbound:${generic.value.type}` };
	}
	return { ok: true, value: generic.value as BgAgentEnvelope<BgAgentOutboundType> };
}

function decodeGenericEnvelope(raw: unknown): DecodeResult<BgAgentEnvelope<string>> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const o = raw as Record<string, unknown>;
	if (typeof o.type !== 'string' || o.type.length === 0) { return { ok: false, reason: 'type-missing' }; }
	if (o.version !== BACKGROUND_AGENT_PROTOCOL_VERSION) {
		return { ok: false, reason: `version-mismatch:${String(o.version)}` };
	}
	if (typeof o.correlationId !== 'string' || !CORRELATION_ID_PATTERN.test(o.correlationId)) {
		return { ok: false, reason: 'correlationId-malformed' };
	}
	return {
		ok: true,
		value: {
			type: o.type,
			version: o.version,
			correlationId: o.correlationId,
			payload: o.payload ?? null,
		},
	};
}

/**
 * Build an outbound envelope from the runner side. Pure — caller
 * supplies a valid correlation id (typically derived from the IDE
 * request id this is responding to).
 */
export function buildOutboundEnvelope<T extends BgAgentOutboundType>(
	type: T,
	correlationId: string,
	payload: unknown,
): DecodeResult<BgAgentEnvelope<T>> {
	if (!OUTBOUND_TYPES.has(type)) { return { ok: false, reason: `type-not-outbound:${type}` }; }
	if (typeof correlationId !== 'string' || !CORRELATION_ID_PATTERN.test(correlationId)) {
		return { ok: false, reason: 'correlationId-malformed' };
	}
	const value: BgAgentEnvelope<T> = {
		type,
		version: BACKGROUND_AGENT_PROTOCOL_VERSION,
		correlationId,
		payload,
	};
	return { ok: true, value };
}

// -----------------------------------------------------------------------------
// Lifecycle FSM (idle → running → paused → resumed → done | aborted | failed)
// -----------------------------------------------------------------------------

export type BgAgentState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'starting'; readonly startedAtMs: number }
	| { readonly kind: 'running'; readonly startedAtMs: number; readonly stepsCompleted: number }
	| { readonly kind: 'paused'; readonly pausedAtMs: number; readonly stepsCompleted: number }
	| { readonly kind: 'aborting'; readonly abortReason: string }
	| { readonly kind: 'done'; readonly endedAtMs: number; readonly stepsCompleted: number; readonly outcome: 'success' | 'failure' | 'aborted' };

export type BgAgentEvent =
	| { readonly kind: 'start'; readonly nowMs: number }
	| { readonly kind: 'ready'; readonly nowMs: number }
	| { readonly kind: 'progress'; readonly stepsCompleted: number }
	| { readonly kind: 'pause'; readonly nowMs: number }
	| { readonly kind: 'resume'; readonly nowMs: number }
	| { readonly kind: 'abort'; readonly reason: string }
	| { readonly kind: 'done'; readonly nowMs: number; readonly outcome: 'success' | 'failure' };

export type BgAgentTransition =
	| { readonly ok: true; readonly next: BgAgentState }
	| { readonly ok: false; readonly reason: string; readonly attemptedFrom: BgAgentState['kind']; readonly attemptedEvent: BgAgentEvent['kind'] };

/**
 * Pure transition function. Refuses unsupported transitions (e.g. `pause`
 * from `idle`) — caller renders a UX error rather than letting the FSM
 * fall through into an inconsistent state.
 */
export function transitionBgAgent(state: BgAgentState, event: BgAgentEvent): BgAgentTransition {
	const fail = (reason: string): BgAgentTransition => ({
		ok: false, reason, attemptedFrom: state.kind, attemptedEvent: event.kind,
	});
	switch (state.kind) {
		case 'idle':
			if (event.kind === 'start') { return { ok: true, next: { kind: 'starting', startedAtMs: event.nowMs } }; }
			return fail('idle-only-accepts-start');
		case 'starting':
			if (event.kind === 'ready') { return { ok: true, next: { kind: 'running', startedAtMs: state.startedAtMs, stepsCompleted: 0 } }; }
			if (event.kind === 'abort') { return { ok: true, next: { kind: 'aborting', abortReason: event.reason } }; }
			return fail('starting-only-accepts-ready-or-abort');
		case 'running':
			if (event.kind === 'progress') {
				return { ok: true, next: { kind: 'running', startedAtMs: state.startedAtMs, stepsCompleted: Math.max(state.stepsCompleted, event.stepsCompleted) } };
			}
			if (event.kind === 'pause') { return { ok: true, next: { kind: 'paused', pausedAtMs: event.nowMs, stepsCompleted: state.stepsCompleted } }; }
			if (event.kind === 'abort') { return { ok: true, next: { kind: 'aborting', abortReason: event.reason } }; }
			if (event.kind === 'done') {
				return { ok: true, next: { kind: 'done', endedAtMs: event.nowMs, stepsCompleted: state.stepsCompleted, outcome: event.outcome } };
			}
			return fail(`running-rejects:${event.kind}`);
		case 'paused':
			if (event.kind === 'resume') {
				return { ok: true, next: { kind: 'running', startedAtMs: event.nowMs, stepsCompleted: state.stepsCompleted } };
			}
			if (event.kind === 'abort') { return { ok: true, next: { kind: 'aborting', abortReason: event.reason } }; }
			return fail('paused-only-accepts-resume-or-abort');
		case 'aborting':
			if (event.kind === 'done') {
				return { ok: true, next: { kind: 'done', endedAtMs: event.nowMs, stepsCompleted: 0, outcome: 'aborted' } };
			}
			return fail('aborting-only-accepts-done');
		case 'done':
			return fail('done-is-terminal');
	}
}

/**
 * Convenience: drive the FSM through a list of events for testing.
 */
export function runBgAgentScenario(
	initial: BgAgentState,
	events: ReadonlyArray<BgAgentEvent>,
): { readonly final: BgAgentState; readonly refused: ReadonlyArray<{ readonly attemptedFrom: BgAgentState['kind']; readonly attemptedEvent: BgAgentEvent['kind']; readonly reason: string }> } {
	let cur = initial;
	const refused: { attemptedFrom: BgAgentState['kind']; attemptedEvent: BgAgentEvent['kind']; reason: string }[] = [];
	for (const e of events) {
		const r = transitionBgAgent(cur, e);
		if (r.ok) {
			cur = r.next;
		} else {
			refused.push({ attemptedFrom: r.attemptedFrom, attemptedEvent: r.attemptedEvent, reason: r.reason });
		}
	}
	return { final: cur, refused };
}
