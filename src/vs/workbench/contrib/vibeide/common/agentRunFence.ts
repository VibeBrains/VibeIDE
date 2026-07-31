/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Fencing tokens for agent-run ownership.
 *
 * A run belongs to the window that started it. When a window dies mid-run its record stays
 * behind in a non-terminal state — and the runtime it spawned may still be alive and writing.
 * The fence answers "who may finish this run": the window that started later always wins, so a
 * write from an abandoned runtime is refused instead of clobbering the live owner.
 *
 * Deliberately file-free and clock-free. The window start timestamp is supplied once per window
 * by the caller, ordering is a plain compare of (windowStartedAtMs, seq), and no counter is kept
 * on disk. Two windows cannot share a fence: the later one has the greater start timestamp, and
 * within one window `seq` keeps runs apart.
 */

export interface AgentRunFence {
	/** Wall-clock start of the owning window (epoch ms). Later window ⇒ greater fence. */
	readonly windowStartedAtMs: number;
	/** Monotonic counter inside one window, starting at 1. */
	readonly seq: number;
}

/** Sort order for fences: negative when `a` is older than `b`. */
export function compareAgentRunFences(a: AgentRunFence, b: AgentRunFence): number {
	if (a.windowStartedAtMs !== b.windowStartedAtMs) {
		return a.windowStartedAtMs - b.windowStartedAtMs;
	}
	return a.seq - b.seq;
}

/** Next fence inside the current window. `lastSeq` is the highest seq handed out so far. */
export function nextAgentRunFence(windowStartedAtMs: number, lastSeq: number): AgentRunFence {
	return { windowStartedAtMs, seq: Math.max(0, lastSeq) + 1 };
}

/**
 * True when the fence a writer holds has been overtaken — i.e. a younger window owns the run now
 * and the write must be refused. Equal fences are the same owner, so they are not superseded.
 */
export function isFenceSuperseded(held: AgentRunFence, observed: AgentRunFence): boolean {
	return compareAgentRunFences(held, observed) < 0;
}

/**
 * Epoch id for one window lifetime. `salt` keeps two windows apart when they start within the
 * same millisecond; the caller supplies it (this module stays free of randomness).
 */
export function formatAgentRunEpoch(windowStartedAtMs: number, salt: string): string {
	return `${windowStartedAtMs.toString(36)}-${salt}`;
}

/** Structural guard for fences read back from disk. */
export function isAgentRunFence(value: unknown): value is AgentRunFence {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Partial<AgentRunFence>;
	return Number.isFinite(candidate.windowStartedAtMs) && Number.isFinite(candidate.seq);
}
