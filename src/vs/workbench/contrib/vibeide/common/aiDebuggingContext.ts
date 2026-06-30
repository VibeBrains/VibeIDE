/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `VibeAIDebuggingService` — breakpoint context formatter (pure helper)
 * (roadmap §"Real-impl tail / Phase 3b — `VibeAIDebuggingService` debug API
 * integration. Framework только; без VS Code Debug API подсказки агенту по
 * breakpoints не работают").
 *
 * Pure helpers — `vscode`-free. Caller wires `vscode.debug.onDidChangeBreakpoints`
 * + `vscode.debug.activeStackTrace` and feeds the captured shapes into these
 * formatters. Helpers produce:
 *   - the agent-facing text describing the breakpoint state
 *   - the variables snapshot stripped of secrets (length-bounded)
 *   - the suggestion priority (which breakpoint should agent address first)
 */

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
	/api[_-]?key/i,
	/secret/i,
	/password/i,
	/token/i,
	/bearer/i,
	/auth/i,
	/credential/i,
];

const MAX_VAR_NAME_LEN = 128;
const MAX_VAR_VALUE_LEN = 200;
const MAX_VARIABLES_PER_FRAME = 20;
const MAX_FRAMES = 10;

export interface BreakpointSnapshot {
	readonly id: string;
	readonly fileUri: string;
	readonly line: number;
	readonly column?: number;
	readonly condition?: string;
	readonly hitCount: number;
	readonly enabled: boolean;
	readonly verified: boolean;
}

export interface VariableSnapshot {
	readonly name: string;
	readonly value: string;
	readonly type?: string;
}

export interface StackFrameSnapshot {
	readonly id: string;
	readonly name: string;
	readonly fileUri?: string;
	readonly line?: number;
	readonly variables: ReadonlyArray<VariableSnapshot>;
}

export interface DebugSessionSnapshot {
	readonly sessionId: string;
	readonly threadId: number;
	readonly stoppedReason?: 'breakpoint' | 'exception' | 'pause' | 'step' | 'entry' | 'goto' | 'function-breakpoint' | 'data-breakpoint';
	readonly frames: ReadonlyArray<StackFrameSnapshot>;
	readonly activeBreakpoint?: BreakpointSnapshot;
}

export interface DebugContextForAgent {
	readonly markdownBody: string;
	readonly redactedVariableNames: readonly string[];
}

/**
 * Compose the agent-facing markdown context for a stopped debug session.
 * Pure — no IO. Rule: empty input on any field → omit that section.
 *
 *   - top heading: stopped reason + breakpoint location (if any)
 *   - call stack: top N frames, function name + file:line
 *   - variables for top frame: secret-redacted, length-clipped
 *   - tail line: hitCount and condition, when present
 */
export function buildDebugContextForAgent(snap: DebugSessionSnapshot): DebugContextForAgent {
	const lines: string[] = [];
	const redactedNames: string[] = [];

	lines.push(`### Debug session ${snap.sessionId} (thread ${snap.threadId})`);
	if (snap.stoppedReason) {
		lines.push(`Stopped: \`${snap.stoppedReason}\``);
	}

	if (snap.activeBreakpoint) {
		const bp = snap.activeBreakpoint;
		const colTail = bp.column !== undefined ? `:${bp.column}` : '';
		lines.push(`Breakpoint: \`${bp.fileUri}\` at line ${bp.line}${colTail} (hits: ${bp.hitCount}, ${bp.enabled ? 'enabled' : 'disabled'}, ${bp.verified ? 'verified' : 'unverified'})`);
		if (bp.condition !== undefined && bp.condition.length > 0) {
			lines.push(`Condition: \`${truncate(bp.condition, MAX_VAR_VALUE_LEN)}\``);
		}
	}

	const frames = snap.frames.slice(0, MAX_FRAMES);
	if (frames.length > 0) {
		lines.push('');
		lines.push('### Call stack');
		for (let i = 0; i < frames.length; i++) {
			const f = frames[i];
			const loc = f.fileUri && typeof f.line === 'number' ? ` — \`${f.fileUri}:${f.line}\`` : '';
			lines.push(`${i + 1}. \`${truncate(f.name, MAX_VAR_NAME_LEN)}\`${loc}`);
		}
		if (snap.frames.length > MAX_FRAMES) {
			lines.push(`…and ${snap.frames.length - MAX_FRAMES} more frames`);
		}
	}

	const top = frames[0];
	if (top !== undefined && top.variables.length > 0) {
		lines.push('');
		lines.push(`### Top-frame variables (${top.name})`);
		const visible = top.variables.slice(0, MAX_VARIABLES_PER_FRAME);
		for (const v of visible) {
			if (looksSecret(v.name)) {
				lines.push(`- \`${truncate(v.name, MAX_VAR_NAME_LEN)}\`: \`[REDACTED]\``);
				redactedNames.push(v.name);
				continue;
			}
			const tail = v.type ? ` *(${v.type})*` : '';
			lines.push(`- \`${truncate(v.name, MAX_VAR_NAME_LEN)}\`${tail}: \`${truncate(v.value, MAX_VAR_VALUE_LEN)}\``);
		}
		if (top.variables.length > MAX_VARIABLES_PER_FRAME) {
			lines.push(`…and ${top.variables.length - MAX_VARIABLES_PER_FRAME} more variables`);
		}
	}

	return {
		markdownBody: lines.join('\n'),
		redactedVariableNames: redactedNames,
	};
}

function looksSecret(name: string): boolean {
	if (typeof name !== 'string') { return false; }
	return SECRET_PATTERNS.some(re => re.test(name));
}

function truncate(s: string, n: number): string {
	if (typeof s !== 'string') { return ''; }
	if (s.length <= n) { return s; }
	return s.slice(0, n - 1) + '…';
}

// -----------------------------------------------------------------------------
// Breakpoint priority — which breakpoint should the agent address first?
// -----------------------------------------------------------------------------

export interface BreakpointPriority {
	readonly id: string;
	readonly score: number;
	readonly reasons: readonly string[];
}

/**
 * Pure: rank breakpoints by "agent attention priority". Higher score =
 * more interesting to look at first.
 *
 * Heuristic:
 *   - hit recently AND many times → highest score (active issue)
 *   - has condition → +20 (intentional, often debugging a specific case)
 *   - unverified → +30 (likely user just added it, expects feedback)
 *   - disabled → -50 (user explicitly turned it off — deprioritise)
 *
 * Returns sorted descending by score, then by id for stable ordering.
 */
export function rankBreakpointsForAgent(
	breakpoints: ReadonlyArray<BreakpointSnapshot>,
): readonly BreakpointPriority[] {
	const out: BreakpointPriority[] = [];
	for (const bp of breakpoints) {
		let score = 0;
		const reasons: string[] = [];
		if (bp.hitCount >= 10) {
			score += 50;
			reasons.push('many-hits');
		} else if (bp.hitCount > 0) {
			score += 10;
			reasons.push('has-hits');
		}
		if (bp.condition !== undefined && bp.condition.length > 0) {
			score += 20;
			reasons.push('has-condition');
		}
		if (!bp.verified) {
			score += 30;
			reasons.push('unverified');
		}
		if (!bp.enabled) {
			score -= 50;
			reasons.push('disabled');
		}
		out.push({ id: bp.id, score, reasons });
	}
	return out.sort((a, b) => {
		if (a.score !== b.score) { return b.score - a.score; }
		return a.id.localeCompare(b.id);
	});
}
