/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * MCP OAuth token rotation policy (920) — pure helper.
 *
 * The full PKCE refresh flow against GitHub / Linear / Notion is blocked
 * on registered apps (878). This module addresses the smaller part: the
 * *policy* that decides "this token is too old, remind the user to
 * rotate" / "this token belongs to an MCP server that was removed,
 * revoke now". The DI service consumes this and emits notifications +
 * `IEncryptionService.deleteSecret` calls.
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
