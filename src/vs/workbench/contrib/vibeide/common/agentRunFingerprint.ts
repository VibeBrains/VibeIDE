/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Session-compatibility fingerprint for agent runs.
 *
 * A durable handoff ticket outlives the window that created it, so a resume can land on ground
 * that has moved — a different model, a widened tool whitelist, another workspace. Comparing
 * loose fields at each call site drifts, so the identity is hashed once and compared as a single
 * value; when it differs, the mismatch names *which* field moved, and the run carries a readable
 * cause instead of resuming silently on new ground.
 *
 * Scope note: the repository commit and the code-graph snapshot are deliberately NOT part of the
 * identity. Both are only reachable from the `browser` layer, while the comparison happens here
 * in `common` where the orchestrator lives. Adding them means introducing a snapshot provider —
 * a separate step, not a field to fake with an empty string.
 *
 * The hash is for equality only, never for security: `StringSHA1` is enough and stays synchronous,
 * which keeps this module pure and testable without a runtime.
 */

import { StringSHA1 } from '../../../../base/common/hash.js';

export interface AgentSessionIdentity {
	/** Subagent role — a planner and a reviewer are never the same session. */
	readonly role: string;
	readonly provider: string;
	readonly model: string;
	readonly parentThreadId: string;
	/** Stable key of the workspace folder the run is bound to. */
	readonly workspaceKey: string;
	/**
	 * Tool whitelist in effect. This *is* the permission model for a role (see the note above
	 * `TOOL_WHITELIST` in `vibeSubagentRegistryService`), so there is no separate policy field to
	 * compare — widening or narrowing this list is exactly what "the rules changed" means.
	 */
	readonly allowedTools: readonly string[];
}

export type AgentSessionMismatch =
	| 'role_changed'
	| 'provider_changed'
	| 'model_changed'
	| 'thread_changed'
	| 'workspace_changed'
	| 'tools_changed';

/**
 * Stable digest of a session identity. Tool order is not identity, so the list is sorted before
 * hashing; every other field is compared verbatim.
 */
export function computeAgentSessionFingerprint(identity: AgentSessionIdentity): string {
	const canonical = [
		identity.role,
		identity.provider,
		identity.model,
		identity.parentThreadId,
		identity.workspaceKey,
		[...identity.allowedTools].sort().join(','),
	].join(' ');

	const sha = new StringSHA1();
	sha.update(canonical);
	return sha.digest();
}

/**
 * First field that moved between two identities, or `undefined` when the run may resume.
 * Order matters: the coarsest difference is reported, so a changed workspace is not described
 * as a changed model.
 */
export function compareAgentSessionIdentity(previous: AgentSessionIdentity, next: AgentSessionIdentity): AgentSessionMismatch | undefined {
	if (previous.role !== next.role) { return 'role_changed'; }
	if (previous.parentThreadId !== next.parentThreadId) { return 'thread_changed'; }
	if (previous.workspaceKey !== next.workspaceKey) { return 'workspace_changed'; }
	if (previous.provider !== next.provider) { return 'provider_changed'; }
	if (previous.model !== next.model) { return 'model_changed'; }

	const previousTools = [...previous.allowedTools].sort().join(',');
	const nextTools = [...next.allowedTools].sort().join(',');
	if (previousTools !== nextTools) { return 'tools_changed'; }

	return undefined;
}

/** Human-readable cause for the run list, mirroring `stopReasonToRussian` in the loop policy. */
export function sessionMismatchToRussian(mismatch: AgentSessionMismatch): string {
	switch (mismatch) {
		case 'role_changed': return 'сменилась роль';
		case 'provider_changed': return 'сменился провайдер';
		case 'model_changed': return 'сменилась модель';
		case 'thread_changed': return 'другой тред чата';
		case 'workspace_changed': return 'сменилась рабочая папка';
		case 'tools_changed': return 'сменился набор инструментов';
	}
}
