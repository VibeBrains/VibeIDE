/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Auto-stash policy decision (1058) — pure helper.
 *
 * Setting `vibeide.git.autoStash`:
 *   - "always"           → stash before every group apply, even when clean.
 *   - "dirty-only"       → stash only when at least one file has unsaved changes.
 *   - "never"            → don't stash; let the user manage their own state.
 *
 * Per-file permissions can override: a file marked "agent-protected" in
 * `VibePerFilePermissionsService` always triggers a stash so the agent
 * can never overwrite human-pending edits silently.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type AutoStashSetting = 'always' | 'dirty-only' | 'never';

export interface FilePerm {
	path: string;
	/**
	 * "agent-protected" = file should never be touched by agent without
	 * an explicit stash + confirmation. Other values use the global
	 * autoStash setting.
	 */
	policy: 'unrestricted' | 'agent-protected' | 'read-only';
}

export interface AutoStashInput {
	setting: AutoStashSetting;
	dirtyFiles: ReadonlyArray<string>;
	editTargets: ReadonlyArray<string>;
	perFilePermissions?: ReadonlyArray<FilePerm>;
}

export type AutoStashDecision =
	| { kind: 'stash'; reason: 'always' | 'dirty-files' | 'protected-target' }
	| { kind: 'skip'; reason: 'never' | 'no-dirty-no-protected' };

/**
 * Decide whether to run `git stash push` before the next agent edit. Pure.
 *
 * Decision priority:
 *   1. Any edit target marked agent-protected → always stash, regardless
 *      of setting (even "never").
 *   2. setting = "always" → always stash.
 *   3. setting = "dirty-only" + any edit target is dirty → stash.
 *   4. setting = "never" → skip.
 *   5. dirty-only with clean targets → skip.
 */
export function decideAutoStash(input: AutoStashInput): AutoStashDecision {
	const targets = new Set(input.editTargets);
	const dirty = new Set(input.dirtyFiles);
	const perms = input.perFilePermissions ?? [];

	for (const perm of perms) {
		if (perm.policy === 'agent-protected' && targets.has(perm.path)) {
			return { kind: 'stash', reason: 'protected-target' };
		}
	}

	if (input.setting === 'always') {
		return { kind: 'stash', reason: 'always' };
	}

	if (input.setting === 'never') {
		return { kind: 'skip', reason: 'never' };
	}

	// dirty-only
	for (const target of input.editTargets) {
		if (dirty.has(target)) {
			return { kind: 'stash', reason: 'dirty-files' };
		}
	}
	return { kind: 'skip', reason: 'no-dirty-no-protected' };
}

/**
 * Decode the user setting input into the strict union, falling back to a
 * safe default when the value is unexpected (typo in settings file).
 */
export function decodeAutoStashSetting(raw: unknown): AutoStashSetting {
	if (raw === 'always' || raw === 'dirty-only' || raw === 'never') {
		return raw;
	}
	return 'dirty-only';
}
