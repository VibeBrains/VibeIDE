/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Inline AI explanations — hover content formatter (pure helper).
 *
 * K.3 line 932 — when the user hovers over a line the agent wrote (gutter shows
 * the agent indicator), the hover should surface a compact summary from the
 * audit log: which prompt session, which plan step, what rationale the tool-call
 * had. This module owns the formatting only — IO (audit query + gutter lookup +
 * context-window truncation) lives in the contribution.
 *
 * Adoption order:
 *   1. Hover provider receives `(uri, position)`.
 *   2. Asks `VibeGutterIndicatorService.getAgentRanges(uri)` for the matching
 *      agent-write range covering the position; pulls its sessionId+timestamp.
 *   3. Calls `VibeAuditLogService.queryRecent(sessionId, ms)` to get the prompt
 *      session header + plan step + tool rationale.
 *   4. Calls `formatInlineAiExplanation({ session, planStep?, rationale?,
 *      writeRange, maxChars? })` — receives a markdown body.
 *   5. Returns the body in the standard VS Code hover.
 *
 * Truncation budget is shared with VibeContextWindowService default — 600 chars
 * on the body is enough for one paragraph + one rationale snippet without
 * crowding small monitors.
 */

export interface SessionRef {
	readonly sessionId: string;
	readonly modelId?: string;
	readonly promptSummary?: string;
	readonly timestampMs: number;
}

export interface PlanStepRef {
	readonly planId: string;
	readonly stepIdx: number;
	readonly stepTitle: string;
}

export interface ToolRationaleRef {
	readonly toolName: string;
	readonly rationale: string;
}

export interface AgentWriteRange {
	readonly filePathBasename: string;
	readonly startLine: number;
	readonly endLine: number;
}

export interface InlineAiExplanationInput {
	readonly session: SessionRef;
	readonly planStep?: PlanStepRef;
	readonly rationale?: ToolRationaleRef;
	readonly writeRange: AgentWriteRange;
	/** Hard budget on the body string. Default 600. */
	readonly maxChars?: number;
}

export interface InlineAiExplanationOutput {
	readonly markdown: string;
	readonly truncated: boolean;
	readonly skippedSections: readonly ('rationale' | 'plan-step' | 'session-summary')[];
}

const DEFAULT_MAX_CHARS = 600;
const TRUNCATION_MARK = '…';

/**
 * Pure: builds a markdown hover body. Sections (in render order):
 *   1. Header — file basename + line range + relative time
 *   2. Session — model + prompt summary (if any)
 *   3. Plan step — title + step number (if any)
 *   4. Rationale — tool name + rationale snippet (if any)
 *
 * Truncation strategy on `maxChars` overflow:
 *   1. Drop rationale's quote (keep tool name).
 *   2. Drop session's prompt summary (keep model + ts).
 *   3. Drop plan step entirely.
 * The `skippedSections` array reports what was dropped so the hover can show a
 * "show full audit" link in the IDE chrome.
 */
export function formatInlineAiExplanation(input: InlineAiExplanationInput, now: number = Date.now()): InlineAiExplanationOutput {
	const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;

	const lines: string[] = [];
	lines.push(`**${input.writeRange.filePathBasename}:${input.writeRange.startLine}-${input.writeRange.endLine}** — VibeIDE agent write _(${formatRelativeTime(now - input.session.timestampMs)})_`);
	lines.push('');

	const sessionLine = input.session.modelId
		? `Session ${input.session.sessionId.slice(0, 8)} · model ${input.session.modelId}`
		: `Session ${input.session.sessionId.slice(0, 8)}`;
	lines.push(sessionLine);

	const sessionSummaryLine = input.session.promptSummary
		? `> ${truncateInline(input.session.promptSummary, 200)}`
		: '';
	if (sessionSummaryLine) { lines.push(sessionSummaryLine); }

	const planLine = input.planStep
		? `Plan **${input.planStep.planId}** step ${input.planStep.stepIdx + 1}: ${truncateInline(input.planStep.stepTitle, 120)}`
		: '';
	if (planLine) { lines.push(planLine); }

	const rationaleHeader = input.rationale ? `Tool: \`${input.rationale.toolName}\`` : '';
	const rationaleQuote = input.rationale ? `> ${truncateInline(input.rationale.rationale, 240)}` : '';
	if (rationaleHeader) { lines.push(rationaleHeader); }
	if (rationaleQuote) { lines.push(rationaleQuote); }

	let markdown = lines.join('\n');
	const skipped: ('rationale' | 'plan-step' | 'session-summary')[] = [];

	if (markdown.length <= maxChars) {
		return { markdown, truncated: false, skippedSections: [] };
	}

	// Step 1: drop rationale quote
	if (rationaleQuote) {
		markdown = withoutLine(markdown, rationaleQuote);
		skipped.push('rationale');
		if (markdown.length <= maxChars) {
			return { markdown, truncated: true, skippedSections: skipped };
		}
	}

	// Step 2: drop session summary
	if (sessionSummaryLine) {
		markdown = withoutLine(markdown, sessionSummaryLine);
		skipped.push('session-summary');
		if (markdown.length <= maxChars) {
			return { markdown, truncated: true, skippedSections: skipped };
		}
	}

	// Step 3: drop plan step
	if (planLine) {
		markdown = withoutLine(markdown, planLine);
		skipped.push('plan-step');
	}

	// Final hard cut if still too long after section drops.
	if (markdown.length > maxChars) {
		markdown = markdown.slice(0, maxChars - TRUNCATION_MARK.length) + TRUNCATION_MARK;
	}
	return { markdown, truncated: true, skippedSections: skipped };
}

/**
 * Pure: shared inline truncator. Used internally; exposed for the hover code's
 * non-section truncations (e.g., chevron labels). Adds `…` at the cut point.
 */
export function truncateInline(s: string, maxChars: number): string {
	if (typeof s !== 'string') { return ''; }
	if (s.length <= maxChars) { return s; }
	if (maxChars <= TRUNCATION_MARK.length) { return TRUNCATION_MARK; }
	return s.slice(0, maxChars - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

/**
 * Pure: human "X minutes ago"-style relative time for the hover header. RU.
 * Negative deltas (clock skew) clamp to "только что".
 */
export function formatRelativeTime(deltaMs: number): string {
	if (!Number.isFinite(deltaMs) || deltaMs < 0) { return 'только что'; }
	if (deltaMs < 60_000) { return `${Math.round(deltaMs / 1_000)}с назад`; }
	if (deltaMs < 3_600_000) { return `${Math.round(deltaMs / 60_000)}м назад`; }
	if (deltaMs < 86_400_000) { return `${Math.round(deltaMs / 3_600_000)}ч назад`; }
	return `${Math.round(deltaMs / 86_400_000)}д назад`;
}

function withoutLine(markdown: string, line: string): string {
	const lines = markdown.split('\n');
	return lines.filter(l => l !== line).join('\n');
}
