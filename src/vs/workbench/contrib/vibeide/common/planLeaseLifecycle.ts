/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure helpers for plan execution lease lifecycle (K.1 / 904 stale lease janitor,
 * K.1 / 907 emergencyStop mass clear).
 *
 * The DI service in `vibePersistedPlanService.ts` keeps `Date.now()` calls inline,
 * which makes its tests indirectly time-dependent. This module exposes the same
 * decisions as plain functions taking `now` as input, so unit tests are
 * deterministic.
 *
 * vscode-free: no imports beyond standard lib.
 */

/** Heartbeat older than this is treated as stale. Mirrors the runtime constant. */
export const PLAN_EXECUTION_LEASE_STALE_AFTER_MS = 120_000;

export interface PlanExecutionLease {
	readonly planId: string;
	readonly threadId: string;
	readonly windowId?: number;
	readonly holderNonce: string;
	readonly startedAt: number;
	readonly lastHeartbeat: number;
}

/**
 * True when the lease's last heartbeat is older than `ttl` against `now`.
 * `undefined` is considered stale (no lease ⇒ no holder ⇒ fair game). This
 * matches the existing service contract where missing leases let the next
 * acquirer through.
 */
export function isLeaseStale(
	lease: PlanExecutionLease | undefined,
	now: number,
	ttl: number = PLAN_EXECUTION_LEASE_STALE_AFTER_MS,
): boolean {
	if (!lease) { return true; }
	return now - lease.lastHeartbeat > ttl;
}

export interface LeaseScanResult {
	stale: PlanExecutionLease[];
	live: PlanExecutionLease[];
}

/**
 * Partition leases into stale vs live buckets. Pure — does not touch the FS.
 * The runtime janitor passes the result into `clearExecutionLease(planId)` for
 * each entry in `stale`.
 */
export function partitionLeases(
	leases: ReadonlyArray<PlanExecutionLease>,
	now: number,
	ttl: number = PLAN_EXECUTION_LEASE_STALE_AFTER_MS,
): LeaseScanResult {
	const stale: PlanExecutionLease[] = [];
	const live: PlanExecutionLease[] = [];
	for (const lease of leases) {
		if (isLeaseStale(lease, now, ttl)) {
			stale.push(lease);
		} else {
			live.push(lease);
		}
	}
	return { stale, live };
}

/**
 * Predicate for the K.1 / 907 "emergencyStopAllAgents" flow: every lease is
 * treated as stale regardless of TTL. Returned as a list so the caller can log
 * exactly what got cleared. Pure.
 */
export function selectAllForEmergencyStop(
	leases: ReadonlyArray<PlanExecutionLease>,
): PlanExecutionLease[] {
	return [...leases];
}

/**
 * Strict envelope decoder for a `.leases/<planId>.json` file. Returns a tagged
 * result instead of throwing — surviving an interrupted write means the file
 * may have a half-written tail.
 */
export function decodeLease(raw: unknown): { ok: true; value: PlanExecutionLease } | { ok: false; reason: string } {
	if (raw === null || raw === undefined || typeof raw !== 'object') {
		return { ok: false, reason: 'not-an-object' };
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.planId !== 'string' || obj.planId.length === 0) { return { ok: false, reason: 'planId-missing' }; }
	if (typeof obj.threadId !== 'string' || obj.threadId.length === 0) { return { ok: false, reason: 'threadId-missing' }; }
	if (typeof obj.holderNonce !== 'string' || obj.holderNonce.length === 0) { return { ok: false, reason: 'holderNonce-missing' }; }
	if (typeof obj.startedAt !== 'number' || !Number.isFinite(obj.startedAt)) { return { ok: false, reason: 'startedAt-invalid' }; }
	if (typeof obj.lastHeartbeat !== 'number' || !Number.isFinite(obj.lastHeartbeat)) { return { ok: false, reason: 'lastHeartbeat-invalid' }; }
	const lease: PlanExecutionLease = {
		planId: obj.planId,
		threadId: obj.threadId,
		holderNonce: obj.holderNonce,
		startedAt: obj.startedAt,
		lastHeartbeat: obj.lastHeartbeat,
	};
	if (typeof obj.windowId === 'number' && Number.isFinite(obj.windowId)) {
		(lease as { windowId?: number }).windowId = obj.windowId;
	}
	return { ok: true, value: lease };
}
