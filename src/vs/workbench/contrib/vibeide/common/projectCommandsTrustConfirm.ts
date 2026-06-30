/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — first-run trust confirmation policy
 * (roadmap §"Безопасность и политика → Confirm-диалог при первом запуске
 * незнакомой команды").
 *
 * Pure decision helper — `vscode`-free — companion to `commandTrustRevoke.ts`
 * (which handles the *revocation* path). This file handles the *up-front*
 * decision: «do we need to show a confirm dialog before running, or has the
 * user already trusted this exact command shape?»
 *
 * Adoption order (in `IVibeCustomCommandsService.run`):
 *   1. Compute `commandShapeHash(cmd)` (caller decides hash function — typically
 *      SHA-256 over command|args|env|cwd, same hash used by `commandTrustRevoke`).
 *   2. Call `decideRunConfirm({ command, currentHash, trustEntry? })`.
 *   3. On `auto-allow` → spawn directly.
 *   4. On `require-confirm` → open `IDialogService` confirm with
 *      `describeConfirmReason()` body; on approve persist a new
 *      `CommandTrustEntry` to `.vibe/commands.trust.json` (atomic temp+rename).
 */

import { ProjectCommand } from './projectCommandsTypes.js';
import { CommandTrustEntry } from './commandTrustRevoke.js';

export type RunConfirmReason =
	| 'first-run'
	| 'shape-changed-since-trust'
	| 'always-confirm';

export type RunConfirmDecision =
	| { readonly kind: 'auto-allow' }
	| { readonly kind: 'require-confirm'; readonly reason: RunConfirmReason };

export interface RunConfirmInput {
	readonly command: Pick<ProjectCommand, 'id' | 'confirm'>;
	readonly currentHash: string;
	readonly trustEntry?: CommandTrustEntry;
}

/**
 * Decision tree (top-down — first match wins):
 *
 *   1. command.confirm === true                        → 'always-confirm'
 *   2. trustEntry === undefined                        → 'first-run'
 *   3. trustEntry.commandShapeHash !== currentHash     → 'shape-changed-since-trust'
 *   4. otherwise                                       → 'auto-allow'
 *
 * Note: when shape changes, the *up-front* decision is `require-confirm` —
 * the *retroactive* revoke decision is the responsibility of
 * `commandTrustRevoke.decideTrustRevocations` and runs as a separate pass.
 */
export function decideRunConfirm(input: RunConfirmInput): RunConfirmDecision {
	if (input.command.confirm === true) {
		return { kind: 'require-confirm', reason: 'always-confirm' };
	}
	if (input.trustEntry === undefined) {
		return { kind: 'require-confirm', reason: 'first-run' };
	}
	if (input.trustEntry.commandShapeHash !== input.currentHash) {
		return { kind: 'require-confirm', reason: 'shape-changed-since-trust' };
	}
	return { kind: 'auto-allow' };
}

/**
 * Bulk variant: useful for the "trust all" / "trust selected" UX. Returns the
 * decision per command id in input order; ids without a current hash are
 * dropped silently (caller is expected to derive hashes for every command in
 * the list).
 */
export function decideRunConfirmBulk(
	commands: ReadonlyArray<{ command: RunConfirmInput['command']; currentHash: string }>,
	trust: ReadonlyArray<CommandTrustEntry>,
): readonly { readonly id: string; readonly decision: RunConfirmDecision }[] {
	const trustById = new Map<string, CommandTrustEntry>();
	for (const t of trust) { trustById.set(t.id, t); }
	return commands.map(({ command, currentHash }) => ({
		id: command.id,
		decision: decideRunConfirm({ command, currentHash, trustEntry: trustById.get(command.id) }),
	}));
}

/**
 * RU body builder for the confirm dialog. Caller composes title separately —
 * helper returns the description paragraph that explains *why* confirmation
 * is being requested. Pure string-formatting only.
 */
export function describeConfirmReason(reason: RunConfirmReason, name: string): string {
	switch (reason) {
		case 'first-run':
			return `Команда «${name}» запускается впервые. Запустить?`;
		case 'shape-changed-since-trust':
			return `Команда «${name}» изменилась с момента последнего разрешения. Подтвердите запуск.`;
		case 'always-confirm':
			return `Команда «${name}» помечена как требующая подтверждения при каждом запуске.`;
	}
}

/**
 * Build a `CommandTrustEntry` to persist after the user approves a confirm.
 * Caller passes the time injection (so unit tests don't depend on `Date.now`).
 */
export function buildTrustEntryAfterApproval(
	command: Pick<ProjectCommand, 'id'>,
	currentHash: string,
	nowMs: number,
): CommandTrustEntry {
	return {
		id: command.id,
		commandShapeHash: currentHash,
		trustedAtMs: nowMs,
		lastUsedAtMs: nowMs,
	};
}
