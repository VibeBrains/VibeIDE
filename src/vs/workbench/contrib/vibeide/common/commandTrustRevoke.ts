/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — trust revocation policy (pure helper).
 *
 * K.2 line 923 — `.vibe/commands.trust.json` records a "trust" verdict per
 * project command id, persisted across runs. The current design has no revoke
 * path: trust granted once stays forever, even if the command body has been
 * edited to do something different. This helper provides three revoke triggers:
 *
 *   - explicit         user invokes `VibeIDE: Revoke trust for project command`
 *   - shape-changed    command's hash today differs from when trust was granted
 *   - orphaned         command id no longer exists in `.vibe/commands.json`
 *
 * Adoption order:
 *   1. `IVibeCustomCommandsService` computes a `commandShapeHash(cmd)` (caller
 *      decides: SHA-256 over command|args|env|cwd is fine).
 *   2. On every command load, runs `decideTrustRevocations({ trust, commands,
 *      hashOf, explicitlyRevokedId? })` and writes `keep[]` back.
 *   3. Each entry in `revoke[]` becomes one `command_trust_revoked` audit event.
 *   4. Palette command `vibeide.commands.revokeTrust` opens a Quick Pick of the
 *      currently-trusted ids and passes the picked id as `explicitlyRevokedId`.
 *
 * vscode-free.
 */

export interface CommandTrustEntry {
	readonly id: string;
	readonly commandShapeHash: string;
	readonly trustedAtMs: number;
	readonly lastUsedAtMs?: number;
}

export interface CommandShape {
	readonly id: string;
	readonly commandShapeHash: string;
}

export type RevocationReason = 'explicit' | 'shape-changed' | 'orphaned';

export interface RevocationDecision {
	readonly id: string;
	readonly reason: RevocationReason;
	/** The hash currently stored in trust.json — useful for the audit payload. */
	readonly oldHash: string;
	/** The current command's hash, when applicable (orphaned entries have no current shape). */
	readonly newHash?: string;
}

export interface TrustRevocationResult {
	readonly keep: readonly CommandTrustEntry[];
	readonly revoke: readonly RevocationDecision[];
}

export interface TrustRevocationInput {
	readonly trust: readonly CommandTrustEntry[];
	readonly commands: readonly CommandShape[];
	/** Optional id the user explicitly chose to revoke. */
	readonly explicitlyRevokedId?: string;
}

/**
 * Pure: partitions trust entries into `{ keep, revoke: [{ id, reason, oldHash, newHash? }] }`.
 *
 * Order of triggers (top-down — first match wins):
 *   1. id === explicitlyRevokedId               → 'explicit'
 *   2. id ∉ commands                            → 'orphaned'
 *   3. trust.commandShapeHash !== current hash  → 'shape-changed'
 *   4. otherwise                                → keep
 */
export function decideTrustRevocations(input: TrustRevocationInput): TrustRevocationResult {
	const byId = new Map<string, CommandShape>();
	for (const c of input.commands) { byId.set(c.id, c); }

	const keep: CommandTrustEntry[] = [];
	const revoke: RevocationDecision[] = [];
	for (const t of input.trust) {
		if (input.explicitlyRevokedId && t.id === input.explicitlyRevokedId) {
			revoke.push({ id: t.id, reason: 'explicit', oldHash: t.commandShapeHash });
			continue;
		}
		const current = byId.get(t.id);
		if (!current) {
			revoke.push({ id: t.id, reason: 'orphaned', oldHash: t.commandShapeHash });
			continue;
		}
		if (current.commandShapeHash !== t.commandShapeHash) {
			revoke.push({
				id: t.id,
				reason: 'shape-changed',
				oldHash: t.commandShapeHash,
				newHash: current.commandShapeHash,
			});
			continue;
		}
		keep.push(t);
	}
	return { keep, revoke };
}

/**
 * Pure: shape validator. Returns the typed array on success or null on any
 * malformation. Bridges between `safeParseConfigJson` and the policy.
 */
export function decodeCommandTrustEntries(raw: unknown): readonly CommandTrustEntry[] | null {
	if (!Array.isArray(raw)) { return null; }
	const out: CommandTrustEntry[] = [];
	for (const r of raw) {
		if (!r || typeof r !== 'object') { return null; }
		const o = r as Record<string, unknown>;
		const id = typeof o.id === 'string' && o.id.length > 0 ? o.id : null;
		const commandShapeHash = typeof o.commandShapeHash === 'string' && o.commandShapeHash.length > 0 ? o.commandShapeHash : null;
		const trustedAtMs = typeof o.trustedAtMs === 'number' && Number.isFinite(o.trustedAtMs) ? o.trustedAtMs : null;
		if (id === null || commandShapeHash === null || trustedAtMs === null) { return null; }
		const lastUsedAtMs = typeof o.lastUsedAtMs === 'number' && Number.isFinite(o.lastUsedAtMs) ? o.lastUsedAtMs : undefined;
		out.push({ id, commandShapeHash, trustedAtMs, ...(lastUsedAtMs !== undefined ? { lastUsedAtMs } : {}) });
	}
	return out;
}

/**
 * Pure: builds the audit-payload list for `command_trust_revoked` events.
 * One record per revocation, with id + reason + hash short prefixes (8 chars
 * is enough for a human; full hash is in the file). `newHash` is omitted when
 * absent (orphaned entries have no current shape).
 */
export function buildTrustRevokeAuditEntries(
	result: TrustRevocationResult,
): readonly { readonly id: string; readonly reason: RevocationReason; readonly oldHashPrefix: string; readonly newHashPrefix?: string }[] {
	return result.revoke.map(d => ({
		id: d.id,
		reason: d.reason,
		oldHashPrefix: d.oldHash.slice(0, 8),
		...(d.newHash ? { newHashPrefix: d.newHash.slice(0, 8) } : {}),
	}));
}
