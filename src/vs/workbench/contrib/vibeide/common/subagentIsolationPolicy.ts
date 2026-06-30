/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `IVibeSubagentService` — isolation policy decoder
 * (roadmap §"Real-impl tail / Phase 3b — `IVibeSubagentService` real
 * isolated runtime (отдельный worker / process с собственным контекстным
 * окном; **критично** для нарратива «explore-subagent не сжигает
 * контекст родителя»)").
 *
 * Pure helpers — `vscode`-free. Caller passes a subagent invocation request
 * + per-subagent-kind config; helper decides:
 *   - which isolation backend to use (worker / child-process / inline-fallback)
 *   - what context window quota the subagent gets
 *   - how parent-context handoff happens (full / summarised / none)
 *
 * Real `Worker` / `child_process.fork` lives in the runtime adapter; this
 * module is the contract.
 */

export type SubagentKind = 'explore' | 'planner' | 'reviewer' | 'researcher' | 'fixer' | 'custom';

export type IsolationBackend = 'worker-thread' | 'child-process' | 'inline-fallback';

export type ParentContextHandoff = 'full' | 'summarised' | 'task-only' | 'none';

export interface SubagentIsolationDecision {
	readonly backend: IsolationBackend;
	readonly contextWindowTokens: number;
	readonly parentHandoff: ParentContextHandoff;
	readonly killTimeoutMs: number;
	readonly reasonCodes: readonly string[];
}

export interface SubagentIsolationInput {
	readonly kind: SubagentKind;
	/** Whether the host runtime supports `Worker` API. */
	readonly hasWorkerSupport: boolean;
	/** Whether `child_process.fork` is allowed (false in browser sandbox). */
	readonly hasChildProcessSupport: boolean;
	/** Parent context window remaining after handoff costs — used for quota. */
	readonly parentRemainingTokens: number;
	/** Configured maximum tokens for any subagent (cap). */
	readonly maxSubagentTokens?: number;
	/** Operator override forcing inline-fallback (e.g. when debugging). */
	readonly forceInline?: boolean;
}

const DEFAULT_MAX_TOKENS = 100_000;
const KILL_TIMEOUT_MS_BY_KIND: Record<SubagentKind, number> = {
	explore: 120_000,
	planner: 180_000,
	reviewer: 60_000,
	researcher: 240_000,
	fixer: 300_000,
	custom: 120_000,
};

/**
 * Decide isolation parameters for a subagent invocation. Pure.
 *
 * Backend selection priority (top-down — first-match wins):
 *   1. forceInline                    → 'inline-fallback' (with warning code)
 *   2. !hasWorkerSupport && !hasChildProcessSupport → 'inline-fallback'
 *      (with 'no-isolation-available' warning code — caller should surface
 *      a banner: this defeats the no-context-burn promise)
 *   3. hasWorkerSupport               → 'worker-thread' (preferred, lighter)
 *   4. hasChildProcessSupport         → 'child-process'
 *
 * Quota: min(parentRemainingTokens / 2, maxSubagentTokens). Floor = 1024.
 * Half-the-parent rule keeps room for the parent to integrate the result.
 *
 * Handoff:
 *   - explore       → 'task-only'   (the whole point is to NOT inherit)
 *   - planner       → 'summarised'  (needs context but compressed)
 *   - reviewer      → 'full'        (needs to see everything to review)
 *   - researcher    → 'task-only'   (independent research)
 *   - fixer         → 'summarised'  (focused on the bug context)
 *   - custom        → 'summarised'  (safe default)
 */
export function decideSubagentIsolation(input: SubagentIsolationInput): SubagentIsolationDecision {
	const reasonCodes: string[] = [];

	let backend: IsolationBackend;
	if (input.forceInline === true) {
		backend = 'inline-fallback';
		reasonCodes.push('force-inline');
	} else if (!input.hasWorkerSupport && !input.hasChildProcessSupport) {
		backend = 'inline-fallback';
		reasonCodes.push('no-isolation-available');
	} else if (input.hasWorkerSupport) {
		backend = 'worker-thread';
	} else {
		backend = 'child-process';
	}

	const cap = typeof input.maxSubagentTokens === 'number' && Number.isFinite(input.maxSubagentTokens) && input.maxSubagentTokens > 0
		? input.maxSubagentTokens
		: DEFAULT_MAX_TOKENS;
	const half = Math.floor(input.parentRemainingTokens / 2);
	const contextWindowTokens = Math.max(1024, Math.min(cap, half));

	if (half < 1024) { reasonCodes.push('parent-low-budget'); }

	const parentHandoff: ParentContextHandoff = handoffForKind(input.kind);
	if (parentHandoff === 'task-only') { reasonCodes.push('isolation-strict'); }

	return {
		backend,
		contextWindowTokens,
		parentHandoff,
		killTimeoutMs: KILL_TIMEOUT_MS_BY_KIND[input.kind] ?? KILL_TIMEOUT_MS_BY_KIND.custom,
		reasonCodes,
	};
}

function handoffForKind(kind: SubagentKind): ParentContextHandoff {
	switch (kind) {
		case 'explore':
		case 'researcher':
			return 'task-only';
		case 'reviewer':
			return 'full';
		case 'planner':
		case 'fixer':
		case 'custom':
		default:
			return 'summarised';
	}
}

/**
 * Pure: render a one-line audit trail for `agent_subagent_invoked` events.
 * Caller writes to the audit log via existing service.
 */
export function describeIsolationDecision(decision: SubagentIsolationDecision, kind: SubagentKind): string {
	const reasons = decision.reasonCodes.length > 0 ? ` [${decision.reasonCodes.join(',')}]` : '';
	return `subagent[${kind}] backend=${decision.backend} ctx=${decision.contextWindowTokens} handoff=${decision.parentHandoff} killAfter=${Math.round(decision.killTimeoutMs / 1000)}s${reasons}`;
}

/**
 * Pure: validates that a host runtime can honour a chosen backend BEFORE
 * the subagent spawns. Returns the offending reasons when refusing.
 */
export function checkIsolationCapability(input: {
	readonly backend: IsolationBackend;
	readonly hasWorkerSupport: boolean;
	readonly hasChildProcessSupport: boolean;
}): { readonly capable: true } | { readonly capable: false; readonly reason: string } {
	if (input.backend === 'worker-thread' && !input.hasWorkerSupport) {
		return { capable: false, reason: 'worker-not-available-in-host' };
	}
	if (input.backend === 'child-process' && !input.hasChildProcessSupport) {
		return { capable: false, reason: 'child-process-not-available-in-host' };
	}
	return { capable: true };
}
