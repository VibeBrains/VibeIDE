/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Who owns the bot.
 *
 * One bot token can be long-polled by exactly one process: whoever calls `getUpdates` first takes
 * the messages, and the other side sees an empty list forever. That failure is invisible — the
 * loser looks healthy, logs nothing, and simply never receives anything, which is precisely how a
 * smoke test can be lost (08.08.2026: a second VibeIDE was running; the fresh one polled into the
 * void while the owner's task went elsewhere).
 *
 * So ownership is claimed explicitly through a lock file shared by every VibeIDE on the machine —
 * dev builds and installed builds have different user-data folders, so the lock cannot live there.
 *
 * Pure decision logic here; the file itself is written by the main process.
 */

/** What a lock file holds. Written as JSON; anything unreadable counts as "no lock". */
export interface VibeTelegramLockFile {
	/** Process holding the bot. */
	readonly pid: number;
	/** Last heartbeat, unix ms — a crashed holder stops refreshing it. */
	readonly refreshedAtMs: number;
	/** Human hint for the message shown to the user: which build holds it. */
	readonly appName?: string;
}

/**
 * How often the holder refreshes the lock, and how long a lock survives without a refresh.
 *
 * The stale window is several heartbeats wide on purpose: a busy machine can skip one, and
 * stealing the bot from a live instance is worse than waiting a minute for a dead one.
 */
export const VIBE_TELEGRAM_LOCK_REFRESH_MS = 30000;
export const VIBE_TELEGRAM_LOCK_STALE_MS = 100000;

export type VibeTelegramLockDecision =
	| { readonly kind: 'take' }
	/** Someone else owns the bot; `holderPid` is for the message, not for control. */
	| { readonly kind: 'yield'; readonly holderPid: number; readonly appName: string | undefined };

/**
 * Whether this process may start polling.
 *
 * `pidAlive` is asked of the caller rather than computed here — checking a process is platform
 * work, and keeping it out leaves this decision testable.
 */
export function decideTelegramLock(args: {
	readonly existing: VibeTelegramLockFile | undefined;
	readonly nowMs: number;
	readonly ownPid: number;
	readonly pidAlive: (pid: number) => boolean;
}): VibeTelegramLockDecision {
	const { existing, nowMs, ownPid, pidAlive } = args;
	if (!existing || !Number.isInteger(existing.pid) || existing.pid <= 0) {
		return { kind: 'take' };
	}
	// Our own leftover lock (same process re-starting the bridge after a settings change) is ours
	// to reclaim — otherwise toggling a setting would lock the window out of its own bot.
	if (existing.pid === ownPid) {
		return { kind: 'take' };
	}
	const fresh = nowMs - existing.refreshedAtMs < VIBE_TELEGRAM_LOCK_STALE_MS;
	if (fresh && pidAlive(existing.pid)) {
		return { kind: 'yield', holderPid: existing.pid, appName: existing.appName };
	}
	// Stale heartbeat or a dead pid: the holder crashed or was killed, and refusing to take over
	// would leave the bridge dead until the user noticed and cleaned up a file they never saw.
	return { kind: 'take' };
}
