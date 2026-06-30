/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — terminal-mode launch policy
 * (roadmap §"Запуск и терминальные режимы": integrated / external / background
 * + singleton + reuse-policy).
 *
 * Pure decision helper — `vscode`-free — so the routing decision can be
 * unit-tested without spawning a real terminal. Returns a discriminated-union
 * **plan** that the runtime executor applies (open ITerminalService session,
 * `child_process.spawn`, OS-specific `cmd /c start`, etc).
 */

import { ProjectCommand } from './projectCommandsTypes.js';

export type ProjectCommandReusePolicy = 'alwaysNew' | 'reuse' | 'reuseAndClear';

export const PROJECT_COMMAND_REUSE_POLICIES: readonly ProjectCommandReusePolicy[] = Object.freeze(
	['alwaysNew', 'reuse', 'reuseAndClear'] as const,
);

export const PROJECT_COMMAND_REUSE_DEFAULT: ProjectCommandReusePolicy = 'reuse';

export type ProjectCommandLaunchOS = 'win32' | 'darwin' | 'linux' | 'unknown';

export type ProjectCommandLaunchPlan =
	| {
		readonly kind: 'open-integrated';
		readonly terminalName: string;
		readonly reuse: ProjectCommandReusePolicy;
	}
	| {
		readonly kind: 'spawn-external';
		readonly os: ProjectCommandLaunchOS;
		readonly externalCommand: string;
		readonly externalArgs: readonly string[];
	}
	| {
		readonly kind: 'spawn-background';
		readonly outputChannel: string;
	}
	| {
		readonly kind: 'refused';
		readonly reason: 'singleton-already-running' | 'unknown-os-for-external';
	};

export interface LaunchPolicyContext {
	readonly command: ProjectCommand;
	readonly os: ProjectCommandLaunchOS;
	readonly reusePolicy?: ProjectCommandReusePolicy;
	/** Whether this command id already has a tracked running instance. */
	readonly isRunning: boolean;
}

export const PROJECT_COMMANDS_OUTPUT_CHANNEL = 'VibeIDE Commands';

const TERMINAL_NAME_PREFIX = 'VibeIDE: ';

/**
 * Decide how to launch a project command. Caller passes a snapshot context;
 * helper does NOT mutate state (`isRunning` is a boolean from the caller).
 *
 * Singleton-семантика (roadmap line 330): when `command.singleton === true`
 * and `isRunning === true`, returns `refused` with `singleton-already-running`
 * — caller surfaces a notification with action «Открыть запущенный».
 */
export function decideProjectCommandLaunch(ctx: LaunchPolicyContext): ProjectCommandLaunchPlan {
	const { command, os, isRunning } = ctx;
	const reuse = decodeReusePolicy(ctx.reusePolicy);

	if (command.singleton === true && isRunning) {
		return { kind: 'refused', reason: 'singleton-already-running' };
	}

	const terminal = command.terminal ?? 'integrated';

	if (terminal === 'integrated') {
		return {
			kind: 'open-integrated',
			terminalName: TERMINAL_NAME_PREFIX + command.name,
			reuse,
		};
	}

	if (terminal === 'background') {
		return {
			kind: 'spawn-background',
			outputChannel: PROJECT_COMMANDS_OUTPUT_CHANNEL,
		};
	}

	// terminal === 'external'
	const ext = buildExternalLaunchSpec(os);
	if (ext === null) {
		return { kind: 'refused', reason: 'unknown-os-for-external' };
	}
	return {
		kind: 'spawn-external',
		os,
		externalCommand: ext.command,
		externalArgs: ext.args,
	};
}

/**
 * Decode `reusePolicy` setting value. Falls back to `reuse` for any unknown /
 * malformed input — matches the "default = reuse" specification.
 */
export function decodeReusePolicy(raw: unknown): ProjectCommandReusePolicy {
	if (typeof raw !== 'string') {
		return PROJECT_COMMAND_REUSE_DEFAULT;
	}
	for (const allowed of PROJECT_COMMAND_REUSE_POLICIES) {
		if (raw === allowed) {
			return allowed;
		}
	}
	return PROJECT_COMMAND_REUSE_DEFAULT;
}

/**
 * Per-OS external-launch spec — does NOT include the user command, just the
 * shell wrapper. Caller appends `command.command` + `args` after.
 *   Windows: `cmd /c start "" <user-command>`
 *   macOS:   `open -a Terminal <…>`
 *   Linux:   `x-terminal-emulator -e <…>` (best-effort; many distros override).
 */
export function buildExternalLaunchSpec(os: ProjectCommandLaunchOS): { command: string; args: readonly string[] } | null {
	switch (os) {
		case 'win32':
			return { command: 'cmd', args: ['/c', 'start', ''] };
		case 'darwin':
			return { command: 'open', args: ['-a', 'Terminal'] };
		case 'linux':
			return { command: 'x-terminal-emulator', args: ['-e'] };
		case 'unknown':
		default:
			return null;
	}
}

/**
 * Detect the launch OS from a `process.platform`-shaped string. Pure — caller
 * passes the value, helper does not read `process` itself.
 */
export function detectLaunchOS(platform: string): ProjectCommandLaunchOS {
	if (platform === 'win32') { return 'win32'; }
	if (platform === 'darwin') { return 'darwin'; }
	if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd' || platform === 'sunos' || platform === 'aix') { return 'linux'; }
	return 'unknown';
}
