/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Roadmap-agent (I.2) — execution loop FSM
 * (roadmap §"Real-impl tail / Phase 3b — Roadmap-agent (I.2) реальный
 * execution loop. Сейчас preview/decide; без loop делегирование пунктов =
 * только UI без действий").
 *
 * Pure decision FSM — `vscode`-free — drives the per-item delegation cycle:
 *   1. select next item (closed-status filter)
 *   2. preview proposed action (existing service)
 *   3. wait for user approval (or auto-approve if policy allows)
 *   4. execute (delegate to subagent / inline)
 *   5. record outcome + next-iter
 *
 * Companion to `planLifecycleStateMachine` (which handles a single plan's
 * lifecycle). This loop iterates *across* roadmap items — picking the
 * next-best-candidate after each completion.
 */

export type RoadmapItemStatus =
	| { readonly kind: 'open' }
	| { readonly kind: 'in-progress'; readonly invocationId: string }
	| { readonly kind: 'previewing'; readonly invocationId: string }
	| { readonly kind: 'awaiting-approval'; readonly invocationId: string }
	| { readonly kind: 'executing'; readonly invocationId: string }
	| { readonly kind: 'completed'; readonly outcome: 'success' | 'failure' | 'skipped' }
	| { readonly kind: 'blocked'; readonly reason: string };

export interface RoadmapItem {
	readonly id: string;
	readonly summary: string;
	readonly bucket: 'must-finish' | 'install-and-finish' | 'skeleton-acceptable' | 'blocked';
	readonly priority: number;
}

export type LoopState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'selecting' }
	| { readonly kind: 'working'; readonly currentItemId: string; readonly status: RoadmapItemStatus }
	| { readonly kind: 'paused'; readonly resumeWith: string | null }
	| { readonly kind: 'finished'; readonly summary: LoopSummary };

export interface LoopSummary {
	readonly closed: number;
	readonly skeleton: number;
	readonly blocked: number;
	readonly skipped: number;
}

export type LoopEvent =
	| { readonly kind: 'start' }
	| { readonly kind: 'item-selected'; readonly itemId: string }
	| { readonly kind: 'no-more-items'; readonly summary: LoopSummary }
	| { readonly kind: 'preview-ready'; readonly invocationId: string }
	| { readonly kind: 'auto-approved'; readonly invocationId: string }
	| { readonly kind: 'user-approved'; readonly invocationId: string }
	| { readonly kind: 'user-rejected'; readonly reason: string }
	| { readonly kind: 'execution-complete'; readonly outcome: 'success' | 'failure' }
	| { readonly kind: 'execution-blocked'; readonly reason: string }
	| { readonly kind: 'pause' }
	| { readonly kind: 'resume' };

export type LoopTransition =
	| { readonly ok: true; readonly next: LoopState; readonly note?: string }
	| { readonly ok: false; readonly reason: string; readonly attemptedFrom: LoopState['kind']; readonly attemptedEvent: LoopEvent['kind'] };

/**
 * Pure transition. Refuses unsupported pairs. Auto-approval rule: if the
 * caller signals `auto-approved`, the loop skips the awaiting-approval
 * state entirely — the invocationId carries through.
 */
export function transitionLoop(state: LoopState, event: LoopEvent): LoopTransition {
	const fail = (reason: string): LoopTransition => ({
		ok: false, reason, attemptedFrom: state.kind, attemptedEvent: event.kind,
	});

	if (event.kind === 'pause') {
		if (state.kind === 'idle' || state.kind === 'finished') { return fail(`pause-rejects-from:${state.kind}`); }
		const resumeWith = state.kind === 'working' ? state.currentItemId : null;
		return { ok: true, next: { kind: 'paused', resumeWith }, note: 'paused-mid-flight' };
	}
	if (event.kind === 'resume' && state.kind === 'paused') {
		if (state.resumeWith !== null) {
			return {
				ok: true,
				next: { kind: 'working', currentItemId: state.resumeWith, status: { kind: 'in-progress', invocationId: state.resumeWith } },
			};
		}
		return { ok: true, next: { kind: 'selecting' } };
	}

	switch (state.kind) {
		case 'idle':
			if (event.kind === 'start') { return { ok: true, next: { kind: 'selecting' } }; }
			return fail(`idle-only-accepts-start:${event.kind}`);
		case 'selecting':
			if (event.kind === 'item-selected') {
				return {
					ok: true,
					next: { kind: 'working', currentItemId: event.itemId, status: { kind: 'in-progress', invocationId: event.itemId } },
				};
			}
			if (event.kind === 'no-more-items') {
				return { ok: true, next: { kind: 'finished', summary: event.summary } };
			}
			return fail(`selecting-rejects:${event.kind}`);
		case 'working':
			if (event.kind === 'preview-ready') {
				return {
					ok: true,
					next: { kind: 'working', currentItemId: state.currentItemId, status: { kind: 'awaiting-approval', invocationId: event.invocationId } },
				};
			}
			if (event.kind === 'auto-approved' || event.kind === 'user-approved') {
				return {
					ok: true,
					next: { kind: 'working', currentItemId: state.currentItemId, status: { kind: 'executing', invocationId: event.invocationId } },
				};
			}
			if (event.kind === 'user-rejected') {
				return {
					ok: true,
					next: { kind: 'selecting' },
					note: `rejected:${event.reason}`,
				};
			}
			if (event.kind === 'execution-complete') {
				return {
					ok: true,
					next: { kind: 'selecting' },
					note: `outcome:${event.outcome}`,
				};
			}
			if (event.kind === 'execution-blocked') {
				return {
					ok: true,
					next: { kind: 'selecting' },
					note: `blocked:${event.reason}`,
				};
			}
			return fail(`working-rejects:${event.kind}`);
		case 'paused':
			return fail(`paused-only-accepts-resume:${event.kind}`);
		case 'finished':
			return fail('finished-is-terminal');
	}
}

/**
 * Pure: rank candidate items by bucket priority + intra-bucket priority.
 * Bucket order: must-finish < install-and-finish < skeleton-acceptable < blocked
 * (lower bucket-rank = higher selection priority). Intra-bucket: numeric
 * priority ascending, then id alphabetical for stability.
 *
 * Returns the items in selection order — caller picks the head. `blocked`
 * items are dropped; the loop never selects them.
 */
export function rankRoadmapItemsForExecution(items: ReadonlyArray<RoadmapItem>): readonly RoadmapItem[] {
	const bucketRank: Record<RoadmapItem['bucket'], number> = {
		'must-finish': 0,
		'install-and-finish': 1,
		'skeleton-acceptable': 2,
		'blocked': 3,
	};
	return [...items]
		.filter(i => i.bucket !== 'blocked')
		.sort((a, b) => {
			const br = bucketRank[a.bucket] - bucketRank[b.bucket];
			if (br !== 0) { return br; }
			if (a.priority !== b.priority) { return a.priority - b.priority; }
			return a.id.localeCompare(b.id);
		});
}

/**
 * Pure: build the LoopSummary from a list of completed item statuses.
 */
export function summarizeLoopOutcomes(
	statuses: ReadonlyArray<RoadmapItemStatus>,
): LoopSummary {
	const skeleton = 0;
	let closed = 0, blocked = 0, skipped = 0;
	for (const s of statuses) {
		if (s.kind === 'completed') {
			if (s.outcome === 'success') { closed++; }
			else if (s.outcome === 'failure') { skipped++; }
			else if (s.outcome === 'skipped') { skipped++; }
		} else if (s.kind === 'blocked') {
			blocked++;
		}
	}
	return { closed, skeleton, blocked, skipped };
}
