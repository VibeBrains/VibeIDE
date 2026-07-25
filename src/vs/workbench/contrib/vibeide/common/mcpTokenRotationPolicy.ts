/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * MCP OAuth token rotation policy — pure helpers.
 *
 * The *policy* half decides "this token is too old, remind the user to rotate" /
 * "this token belongs to an MCP server that was removed, revoke now". The
 * *adapter* half (`buildMcpTokenRecords`) turns what the workbench actually
 * stores about MCP authorization into the records the policy reads.
 *
 * Tokens live in the upstream dynamic-auth store, not in any VibeIDE service:
 * MCP servers authorize through `contrib/mcp` → `extHostAuthentication`, which
 * keeps sessions per authorization server and records per-server usage. The
 * contribution feeds both into the adapter below.
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface MCPTokenRecord {
	serverId: string;
	provider: string; // 'github' | 'linear' | 'notion' | …
	storedAt: number; // unix ms
	lastUsedAt: number | null;
	/** Optional explicit OAuth `expires_at` if the provider returned one. */
	expiresAt?: number;
}

export interface RotationPolicyConfig {
	/** Default 90 days — soft reminder threshold. */
	rotationReminderAfterMs: number;
	/** Default 365 days — hard rotation requirement (no usage allowed past this). */
	rotationHardLimitMs: number;
	/** Idle window after which an unused token is auto-revoked. Default 180 days. */
	idleAutoRevokeAfterMs: number;
}

const DAY = 24 * 60 * 60 * 1000;
export const ROTATION_DEFAULTS: RotationPolicyConfig = {
	rotationReminderAfterMs: 90 * DAY,
	rotationHardLimitMs: 365 * DAY,
	idleAutoRevokeAfterMs: 180 * DAY,
};

export type RotationDecision =
	| { kind: 'no-op' }
	| { kind: 'remind'; serverId: string; reason: 'soft-rotation-due' | 'expires-soon' }
	| { kind: 'auto-revoke'; serverId: string; reason: 'hard-limit-passed' | 'expired' | 'idle-too-long' | 'server-removed' };

/**
 * Decide what to do with one token. Pure — caller passes `now` and the
 * set of currently-known MCP server ids (so removing a server triggers
 * `auto-revoke` regardless of token age).
 */
export function decideRotationAction(
	token: MCPTokenRecord,
	now: number,
	knownServerIds: ReadonlySet<string>,
	config: RotationPolicyConfig = ROTATION_DEFAULTS,
): RotationDecision {
	if (!knownServerIds.has(token.serverId)) {
		return { kind: 'auto-revoke', serverId: token.serverId, reason: 'server-removed' };
	}

	if (typeof token.expiresAt === 'number' && Number.isFinite(token.expiresAt) && now >= token.expiresAt) {
		return { kind: 'auto-revoke', serverId: token.serverId, reason: 'expired' };
	}

	const ageMs = now - token.storedAt;
	if (ageMs > config.rotationHardLimitMs) {
		return { kind: 'auto-revoke', serverId: token.serverId, reason: 'hard-limit-passed' };
	}

	const lastUsed = token.lastUsedAt ?? token.storedAt;
	const idleMs = now - lastUsed;
	if (idleMs > config.idleAutoRevokeAfterMs) {
		return { kind: 'auto-revoke', serverId: token.serverId, reason: 'idle-too-long' };
	}

	if (typeof token.expiresAt === 'number' && Number.isFinite(token.expiresAt)) {
		const msToExpiry = token.expiresAt - now;
		if (msToExpiry <= 7 * DAY) {
			return { kind: 'remind', serverId: token.serverId, reason: 'expires-soon' };
		}
	}

	if (ageMs > config.rotationReminderAfterMs) {
		return { kind: 'remind', serverId: token.serverId, reason: 'soft-rotation-due' };
	}

	return { kind: 'no-op' };
}

/**
 * Walk an entire token store and return all decisions. Pure — runtime
 * applies them in order (notifications first, revokes second is a sane
 * default).
 */
export function decideRotationsForAll(
	tokens: ReadonlyArray<MCPTokenRecord>,
	now: number,
	knownServerIds: ReadonlySet<string>,
	config: RotationPolicyConfig = ROTATION_DEFAULTS,
): RotationDecision[] {
	const decisions: RotationDecision[] = [];
	for (const token of tokens) {
		const d = decideRotationAction(token, now, knownServerIds, config);
		if (d.kind !== 'no-op') {
			decisions.push(d);
		}
	}
	return decisions;
}

// ── Adapter: workbench authorization state → policy records ────────────────────

/** One stored session of a dynamic authentication provider, as the secret store keeps it. */
export interface UpstreamAuthSession {
	/** Unix ms the token was issued (`created_at` in the dynamic-provider store). */
	createdAt: number;
	/** Access-token lifetime in seconds (`expires_in`), when the server returned one. */
	expiresInSeconds?: number;
	/** Whether the session carries a refresh token. */
	hasRefreshToken: boolean;
	/** Account the session belongs to; usage records are keyed by this label. */
	accountLabel: string;
}

/** Everything known about one authorization server and the MCP servers using it. */
export interface UpstreamProviderTokens {
	providerId: string;
	sessions: readonly UpstreamAuthSession[];
	/** MCP servers observed using this provider's accounts. */
	usages: readonly { mcpServerId: string; accountLabel: string; lastUsed: number }[];
}

/** A policy record plus the coordinates needed to act on it (revoke the right session). */
export interface McpTokenRotationTarget {
	record: MCPTokenRecord;
	providerId: string;
	accountLabel: string;
}

/**
 * Join stored sessions with per-server usage into policy records.
 *
 * Two deliberate rules:
 *  - A session carrying a refresh token gets NO `expiresAt`. Its access token expires
 *    constantly and the workbench renews it silently; treating that as "expired" would
 *    revoke a perfectly healthy login. Age and idleness still apply — those are what the
 *    rotation policy is actually about.
 *  - A usage record with no matching session is skipped: the login is already gone, so
 *    there is nothing left to rotate or revoke.
 */
export function buildMcpTokenRecords(providers: readonly UpstreamProviderTokens[]): McpTokenRotationTarget[] {
	const targets: McpTokenRotationTarget[] = [];
	for (const provider of providers) {
		// Newest session per account — an account may accumulate several over time.
		const newestByAccount = new Map<string, UpstreamAuthSession>();
		for (const session of provider.sessions) {
			const current = newestByAccount.get(session.accountLabel);
			if (!current || session.createdAt > current.createdAt) {
				newestByAccount.set(session.accountLabel, session);
			}
		}

		for (const usage of provider.usages) {
			const session = newestByAccount.get(usage.accountLabel);
			if (!session) {
				continue;
			}
			const expiresAt = !session.hasRefreshToken && typeof session.expiresInSeconds === 'number' && Number.isFinite(session.expiresInSeconds)
				? session.createdAt + session.expiresInSeconds * 1000
				: undefined;
			targets.push({
				providerId: provider.providerId,
				accountLabel: usage.accountLabel,
				record: {
					serverId: usage.mcpServerId,
					provider: provider.providerId,
					storedAt: session.createdAt,
					lastUsedAt: Number.isFinite(usage.lastUsed) ? usage.lastUsed : null,
					expiresAt,
				},
			});
		}
	}
	return targets;
}
