/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Agent territorial locks — disposal policy (pure helper).
 *
 * B.2 line 907 — `.vibe/agent-locks.json` accumulates locks held by chat threads that
 * may be disposed (closed window, killed thread, EH crash). The current TTL is 5–10
 * minutes, so until then locks stay live and block other agents on the same paths.
 * Listening for disposal lets the runtime release locks immediately.
 *
 * This module owns the decision logic: given the current lock document, the set of
 * disposed session/thread IDs, and the surviving session IDs, return the partition
 * `{ keep, release }`. The runtime contribution writes the new document atomically.
 *
 * Adoption order:
 *   1. `IVibeAgentTerritorialLockService` listens on
 *      `IChatThreadService.onDidDisposeThread` (or workbench `onWillShutdown`).
 *   2. On event, calls `filterLocksForDisposal({ locks, disposedHolders, livingHolders, now })`.
 *   3. Writes back the `keep` array via atomic temp+rename.
 *   4. Audit log: `agent_lock_released` per item in `release`.
 */

export interface AgentLockEntry {
	readonly holder: string;        // session-or-window-id; matches dispose event payload
	readonly paths: readonly string[];
	readonly until: string;         // ISO 8601
	readonly reason?: string;       // e.g. "edit:tool-call:writeFile"
}

export type ReleaseReason =
	| 'holder-disposed'
	| 'ttl-expired'
	| 'unknown-holder';

export interface ReleaseDecisionEntry {
	readonly entry: AgentLockEntry;
	readonly reason: ReleaseReason;
}

export interface DisposalResult {
	readonly keep: readonly AgentLockEntry[];
	readonly release: readonly ReleaseDecisionEntry[];
}

export interface DisposalInput {
	readonly locks: readonly AgentLockEntry[];
	/** Set of holder IDs whose disposal triggered this call. */
	readonly disposedHolders: ReadonlySet<string>;
	/**
	 * Optional set of currently-living holder IDs. When provided, locks held by
	 * an unknown holder (neither disposed nor living) are ALSO released — these
	 * are stale leftovers from a previous EH crash that the new EH lifted from
	 * disk on startup. When NOT provided, only `disposedHolders` triggers release.
	 */
	readonly livingHolders?: ReadonlySet<string>;
	/** Current time, ms. Used to detect TTL-expired locks. */
	readonly now: number;
}

/**
 * Pure: partitions a lock document into `{ keep, release }`. Never mutates input.
 *
 * Release rules (top to bottom):
 *   1. holder ∈ disposedHolders        → release (reason: holder-disposed)
 *   2. lock.until < now (TTL passed)   → release (reason: ttl-expired)
 *   3. livingHolders provided AND
 *      holder ∉ livingHolders          → release (reason: unknown-holder, post-crash cleanup)
 *   4. otherwise                       → keep
 *
 * Locks with malformed `until` (non-ISO, NaN parse) are kept silently — the caller
 * should run `vibe doctor` separately to surface them.
 */
export function filterLocksForDisposal(input: DisposalInput): DisposalResult {
	const keep: AgentLockEntry[] = [];
	const release: ReleaseDecisionEntry[] = [];
	for (const entry of input.locks) {
		if (input.disposedHolders.has(entry.holder)) {
			release.push({ entry, reason: 'holder-disposed' });
			continue;
		}
		const expiresAt = parseIsoMs(entry.until);
		if (expiresAt !== null && expiresAt < input.now) {
			release.push({ entry, reason: 'ttl-expired' });
			continue;
		}
		if (input.livingHolders && !input.livingHolders.has(entry.holder)) {
			release.push({ entry, reason: 'unknown-holder' });
			continue;
		}
		keep.push(entry);
	}
	return { keep, release };
}

/**
 * Pure: parses ISO 8601 → ms epoch, or null on malformation. NaN is mapped to null
 * so the caller never has to special-case it.
 */
export function parseIsoMs(iso: string): number | null {
	if (typeof iso !== 'string' || iso.length === 0) { return null; }
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Pure: builds an audit-payload object summarising the disposal — one record per
 * released lock, with the holder + paths + reason. Suitable for `recordAgentEvent`.
 * Never includes the `reason` field of the lock itself in audit payload (it may
 * contain secret-shaped strings like file paths into .vibe/secrets).
 */
export function buildLockReleaseAuditEntries(
	result: DisposalResult,
): readonly { readonly holder: string; readonly paths: readonly string[]; readonly reason: ReleaseReason }[] {
	return result.release.map(d => ({
		holder: d.entry.holder,
		paths: d.entry.paths,
		reason: d.reason,
	}));
}

/**
 * Pure: validates lock document shape. Returns the typed array on success, null on
 * any malformation. Use as the bridge between `safeParseConfigJson` and the
 * disposal policy.
 */
export function decodeAgentLocks(raw: unknown): readonly AgentLockEntry[] | null {
	if (!Array.isArray(raw)) { return null; }
	const out: AgentLockEntry[] = [];
	for (const r of raw) {
		if (!r || typeof r !== 'object') { return null; }
		const o = r as Record<string, unknown>;
		const holder = typeof o.holder === 'string' && o.holder.length > 0 ? o.holder : null;
		const paths = Array.isArray(o.paths) && o.paths.every(p => typeof p === 'string') ? o.paths as string[] : null;
		const until = typeof o.until === 'string' && o.until.length > 0 ? o.until : null;
		if (holder === null || paths === null || until === null) { return null; }
		const reason = typeof o.reason === 'string' && o.reason.length > 0 ? o.reason : undefined;
		out.push({ holder, paths, until, ...(reason ? { reason } : {}) });
	}
	return out;
}
