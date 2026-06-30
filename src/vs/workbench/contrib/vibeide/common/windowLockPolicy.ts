/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Multi-window coordinator — pure decision helper.
 *
 * L.4 line 1034 — two VibeIDE instances on the same workspace race on the .vibe/
 * watcher and on .vibe/agent-locks.json. Solution: a single .vibe/.window-lock.json
 * file holds the PID + heartbeat of the current owner; secondary instances either
 * become observers (read-only for .vibe/) or, if the owner died, take over.
 *
 * This module owns the decision logic only — file IO, heartbeat scheduling, and
 * banner display live in the runtime contribution. Adoption order:
 *   1. On startup, read .vibe/.window-lock.json (or treat missing as "first-owner").
 *   2. Call `decideWindowRole({ now, currentPid, currentWindowId, lock, ttlMs })`.
 *   3. Branch on the returned `role`:
 *        - 'first-owner'         → write a new lock with our PID, start heartbeat.
 *        - 'owner'               → we already hold it (after-restart re-attach), keep heartbeating.
 *        - 'takeover-candidate'  → stale lock, take over (write new lock) and notify user.
 *        - 'observer'            → valid foreign lock, set .vibe/ to read-only-watcher mode.
 *
 * Heartbeat cadence is the runtime's responsibility; recommended default is 20 s
 * cadence with a 60 s TTL (miss-three policy).
 */

export interface WindowLock {
	readonly pid: number;
	readonly startedAtMs: number;
	readonly lastHeartbeatAtMs: number;
	/** Optional stable instance id (UUID); preferred over PID for fork detection. */
	readonly windowId?: string;
}

export type WindowRole =
	| { readonly role: 'first-owner'; readonly reason: 'no-lock' }
	| { readonly role: 'owner'; readonly reason: 'pid-match' | 'window-id-match' }
	| { readonly role: 'takeover-candidate'; readonly reason: 'stale-heartbeat' | 'pid-vanished'; readonly staleByMs: number }
	| { readonly role: 'observer'; readonly reason: 'foreign-lock-valid'; readonly heartbeatAgeMs: number };

export interface WindowRoleInput {
	readonly now: number;
	readonly currentPid: number;
	readonly currentWindowId?: string;
	/** Parsed lock contents, or null/undefined when the file doesn't exist. */
	readonly lock: WindowLock | null | undefined;
	/** TTL in ms after which a heartbeat is considered stale. Default: 60000. */
	readonly ttlMs?: number;
	/** Optional liveness check — call if the runtime can verify the recorded PID is still alive (`process.kill(pid, 0)`-style). */
	readonly isPidAlive?: (pid: number) => boolean;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * Pure: classifies the current window's relationship to an existing lock. Never throws;
 * malformed lock contents (caller passes them as `null`) are treated as "no lock".
 */
export function decideWindowRole(input: WindowRoleInput): WindowRole {
	const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
	if (!input.lock) {
		return { role: 'first-owner', reason: 'no-lock' };
	}
	if (input.currentWindowId !== undefined && input.lock.windowId === input.currentWindowId) {
		return { role: 'owner', reason: 'window-id-match' };
	}
	if (input.lock.pid === input.currentPid) {
		return { role: 'owner', reason: 'pid-match' };
	}
	const heartbeatAgeMs = Math.max(0, input.now - input.lock.lastHeartbeatAtMs);
	if (heartbeatAgeMs > ttlMs) {
		return { role: 'takeover-candidate', reason: 'stale-heartbeat', staleByMs: heartbeatAgeMs - ttlMs };
	}
	if (input.isPidAlive && !input.isPidAlive(input.lock.pid)) {
		return { role: 'takeover-candidate', reason: 'pid-vanished', staleByMs: 0 };
	}
	return { role: 'observer', reason: 'foreign-lock-valid', heartbeatAgeMs };
}

/**
 * Pure: validates parsed lock JSON shape. Returns the typed value on success or `null`
 * on any malformation. Use to bridge between `safeParseConfigJson` and `decideWindowRole`.
 */
export function decodeWindowLock(raw: unknown): WindowLock | null {
	if (!raw || typeof raw !== 'object') { return null; }
	const r = raw as Record<string, unknown>;
	const pid = typeof r.pid === 'number' && Number.isFinite(r.pid) && r.pid > 0 ? r.pid : null;
	const startedAtMs = typeof r.startedAtMs === 'number' && Number.isFinite(r.startedAtMs) ? r.startedAtMs : null;
	const lastHeartbeatAtMs = typeof r.lastHeartbeatAtMs === 'number' && Number.isFinite(r.lastHeartbeatAtMs) ? r.lastHeartbeatAtMs : null;
	if (pid === null || startedAtMs === null || lastHeartbeatAtMs === null) { return null; }
	const windowId = typeof r.windowId === 'string' && r.windowId.length > 0 ? r.windowId : undefined;
	return { pid, startedAtMs, lastHeartbeatAtMs, windowId };
}

/**
 * Pure: builds the lock document the runtime should write. Caller is responsible for
 * atomic write (temp + rename) — this helper only shapes the bytes.
 */
export function buildWindowLock(currentPid: number, now: number, windowId?: string): WindowLock {
	return {
		pid: currentPid,
		startedAtMs: now,
		lastHeartbeatAtMs: now,
		...(windowId ? { windowId } : {}),
	};
}

/**
 * Pure: produces the next heartbeat-tick lock document (same identity, refreshed timestamp).
 * Use on heartbeat schedule fire.
 */
export function refreshWindowLockHeartbeat(prev: WindowLock, now: number): WindowLock {
	return { ...prev, lastHeartbeatAtMs: now };
}
