/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — workspace-first shell shortcuts (roadmap §"Project Commands").
 *
 * This module is the **pure types + decoder skeleton**. The runtime service
 * (`IVibeCustomCommandsService`), the FS watcher on `.vibe/commands.json`, the
 * top-bar contribution, and the `.vscode/tasks.json` importer are deferred —
 * see roadmap §"Project Commands" for the full task list. They sit on top of
 * the data shape defined here.
 *
 * vscode-free: no imports beyond standard lib so the decoder can be unit-tested
 * end-to-end without a workbench harness.
 */

export type ProjectCommandTerminal = 'integrated' | 'external' | 'background';

export interface ProjectCommand {
	id: string;
	name: string;
	description?: string;
	icon?: string;
	color?: string;
	command: string;
	args?: readonly string[];
	cwd?: string;
	env?: Readonly<Record<string, string>>;
	terminal?: ProjectCommandTerminal;
	shell?: boolean;
	confirm?: boolean;
	singleton?: boolean;
	pinned?: boolean;
	order?: number;
	workflowId?: string;
}

export interface ProjectCommandsFile {
	vibeVersion: string;
	commands: readonly ProjectCommand[];
}

export const PROJECT_COMMAND_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Sentinel error thrown by skeleton runtime hooks until the real service ships. */
export class ProjectCommandsNotImplementedError extends Error {
	constructor(operation: string) {
		super(`Project Commands runtime is not yet implemented (operation: ${operation}). See roadmap §"Project Commands".`);
		this.name = 'ProjectCommandsNotImplementedError';
	}
}

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Strict decoder for `.vibe/commands.json`. Returns a tagged result instead of
 * throwing — caller decides whether to surface a banner, fall back to defaults,
 * or refuse to register dynamic commands.
 */
export function decodeProjectCommandsFile(raw: unknown): DecodeResult<ProjectCommandsFile> {
	if (raw === null || raw === undefined || typeof raw !== 'object') {
		return { ok: false, reason: 'not-an-object' };
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.vibeVersion !== 'string' || obj.vibeVersion.length === 0) {
		return { ok: false, reason: 'vibeVersion-missing' };
	}
	if (!Array.isArray(obj.commands)) {
		return { ok: false, reason: 'commands-not-array' };
	}
	const commands: ProjectCommand[] = [];
	const seenIds = new Set<string>();
	for (let i = 0; i < obj.commands.length; i++) {
		const item = obj.commands[i];
		const decoded = decodeProjectCommand(item);
		if (!decoded.ok) {
			return { ok: false, reason: `commands[${i}]:${decoded.reason}` };
		}
		if (seenIds.has(decoded.value.id)) {
			return { ok: false, reason: `commands[${i}]:duplicate-id:${decoded.value.id}` };
		}
		seenIds.add(decoded.value.id);
		commands.push(decoded.value);
	}
	return { ok: true, value: { vibeVersion: obj.vibeVersion, commands } };
}

function decodeProjectCommand(raw: unknown): DecodeResult<ProjectCommand> {
	if (raw === null || raw === undefined || typeof raw !== 'object') {
		return { ok: false, reason: 'not-an-object' };
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.id !== 'string' || !PROJECT_COMMAND_ID_PATTERN.test(obj.id)) {
		return { ok: false, reason: 'id-invalid' };
	}
	if (typeof obj.name !== 'string' || obj.name.length === 0) {
		return { ok: false, reason: 'name-missing' };
	}
	if (typeof obj.command !== 'string' || obj.command.length === 0) {
		return { ok: false, reason: 'command-missing' };
	}
	if (obj.terminal !== undefined && obj.terminal !== 'integrated' && obj.terminal !== 'external' && obj.terminal !== 'background') {
		return { ok: false, reason: 'terminal-invalid' };
	}
	if (obj.args !== undefined && (!Array.isArray(obj.args) || !obj.args.every(a => typeof a === 'string'))) {
		return { ok: false, reason: 'args-invalid' };
	}
	if (obj.env !== undefined) {
		if (obj.env === null || typeof obj.env !== 'object') {
			return { ok: false, reason: 'env-invalid' };
		}
		for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
			if (typeof v !== 'string') {
				return { ok: false, reason: `env.${k}-not-string` };
			}
		}
	}
	const cmd: ProjectCommand = {
		id: obj.id,
		name: obj.name,
		command: obj.command,
	};
	if (typeof obj.description === 'string') { cmd.description = obj.description; }
	if (typeof obj.icon === 'string') { cmd.icon = obj.icon; }
	if (typeof obj.color === 'string') { cmd.color = obj.color; }
	if (Array.isArray(obj.args)) { cmd.args = obj.args.slice() as string[]; }
	if (typeof obj.cwd === 'string') { cmd.cwd = obj.cwd; }
	if (obj.env && typeof obj.env === 'object') { cmd.env = { ...(obj.env as Record<string, string>) }; }
	if (obj.terminal === 'integrated' || obj.terminal === 'external' || obj.terminal === 'background') { cmd.terminal = obj.terminal; }
	if (typeof obj.shell === 'boolean') { cmd.shell = obj.shell; }
	if (typeof obj.confirm === 'boolean') { cmd.confirm = obj.confirm; }
	if (typeof obj.singleton === 'boolean') { cmd.singleton = obj.singleton; }
	if (typeof obj.pinned === 'boolean') { cmd.pinned = obj.pinned; }
	if (typeof obj.order === 'number' && Number.isFinite(obj.order)) { cmd.order = obj.order; }
	if (typeof obj.workflowId === 'string') { cmd.workflowId = obj.workflowId; }
	return { ok: true, value: cmd };
}

/**
 * Stable ordering for top-bar / palette rendering: by `order` ascending (default
 * `Number.MAX_SAFE_INTEGER`), then by `name` for deterministic tie-break.
 */
export function sortProjectCommandsForDisplay(commands: ReadonlyArray<ProjectCommand>): ProjectCommand[] {
	return [...commands].sort((a, b) => {
		const oa = a.order ?? Number.MAX_SAFE_INTEGER;
		const ob = b.order ?? Number.MAX_SAFE_INTEGER;
		if (oa !== ob) { return oa - ob; }
		return a.name.localeCompare(b.name);
	});
}
