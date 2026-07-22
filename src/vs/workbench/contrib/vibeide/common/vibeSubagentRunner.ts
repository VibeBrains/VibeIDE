/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ModelSelection, ProviderId } from './vibeideSettingsTypes.js';
import type { SubagentType, ExploreSubagentReport } from './vibeSubagentService.js';
import type { SubagentStopReason } from './subagentLoopPolicy.js';
import type { ChatImageAttachment } from './chatThreadServiceTypes.js';

/**
 * Headless subagent runner contract (Phase 3b). Declared in `common` so
 * `vibeSubagentService` (common) can depend on it; the implementation — a real
 * LLM↔tools loop over renderer services — lives in `browser/vibeSubagentRunnerService.ts`.
 *
 * Context isolation follows roadmap § I.0: the subagent gets its OWN transcript
 * (an in-memory message buffer, never the thread store) and its own budgets.
 */

export interface SubagentRunRequest {
	readonly subagentId: string;
	/** Role/type — the runner resolves its preset (framing, display name) from the registry. */
	readonly type: SubagentType;
	readonly goal: string;
	readonly acceptanceCriteria?: string;
	readonly contextItems?: readonly string[];
	/** Image attachments for the subagent's first user message (VA vision routing, звено 2). */
	readonly images?: readonly ChatImageAttachment[];
	/** Runtime-enforced tool whitelist (constraints inheritance — never weakened). */
	readonly allowedTools: readonly string[];
	readonly maxSteps: number;
	/** Estimated-token quota (0 = unlimited). */
	readonly maxTokensEst: number;
	/** Wall-clock limit in ms (0 = no limit). */
	readonly maxWallClockMs: number;
	/** Per-role model (roadmap VA.2 «модель на роль»); null/undefined → the session's Chat model. */
	readonly modelSelection?: ModelSelection | null;
	/**
	 * Cooperative cancellation (audit A): checked at every hop boundary AND aborts the
	 * in-flight LLM request. Without it a disposed subagent kept burning tokens to its limits.
	 */
	readonly cancellationToken?: CancellationToken;
	/** Live per-hop callback: running estimated-token total, completed steps, and the current absolute
	 *  wall-clock deadline (unix ms; 0 = none). Drives the chat spinner readout + countdown. */
	readonly onProgress?: (tokensUsedEst: number, stepsDone: number, deadlineAtMs: number) => void;
}

export interface SubagentRunOutcome {
	readonly status: 'success' | 'failed' | 'stopped';
	/** Compact summary (≤500 chars — the handoff contract). */
	readonly summary: string;
	/** File paths touched by write-tools during the run. */
	readonly artifacts: string[];
	/** ESTIMATED tokens spent (chars/4 heuristic) — not provider-reported usage. */
	readonly tokensUsedEst: number;
	/** True when a step/deadline/token/denied-actions limit ended the run early. */
	readonly truncated: boolean;
	/** Human-readable stop cause for logs/summary. */
	readonly stopReason: string;
	/** Machine-readable stop cause when a limit ended the run — drives the resume policy (auto vs manual). */
	readonly stopCode?: SubagentStopReason;
	/** Provider-reported prompt/completion token sums (raw, incl. cached reads) — for cost display. */
	readonly promptTokensUsed?: number;
	readonly completionTokensUsed?: number;
	/** Model that actually ran the role (per-role mapping may differ from the Chat model). */
	readonly providerName?: ProviderId;
	readonly modelName?: string;
	readonly exploreReport?: ExploreSubagentReport;
}

export const IVibeSubagentRunner = createDecorator<IVibeSubagentRunner>('vibeSubagentRunner');

export interface IVibeSubagentRunner {
	readonly _serviceBrand: undefined;
	/** Execute the isolated tool-loop for one subagent and return its compact outcome. */
	run(request: SubagentRunRequest): Promise<SubagentRunOutcome>;
}
