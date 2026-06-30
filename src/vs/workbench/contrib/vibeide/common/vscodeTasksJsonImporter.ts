/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `.vscode/tasks.json` → Project Commands importer (317) — pure mapper.
 *
 * Translates a parsed VS Code tasks.json structure into ProjectCommand
 * objects ready for `.vibe/commands.json`. The Quick Pick palette in the
 * runtime renders the preview from the result before writing.
 *
 * vscode-free: no imports beyond standard lib + ProjectCommand types.
 */

import { PROJECT_COMMAND_ID_PATTERN, type ProjectCommand, type ProjectCommandTerminal } from './projectCommandsTypes.js';

export interface VsCodeTask {
	label?: string;
	type?: 'shell' | 'process' | string;
	command?: string;
	args?: ReadonlyArray<string | { value: string }>;
	options?: { cwd?: string; env?: Record<string, string> };
	problemMatcher?: unknown;
	group?: unknown;
}

export interface ImportPreview {
	imported: ReadonlyArray<{ command: ProjectCommand; sourceLabel: string }>;
	skipped: ReadonlyArray<{ sourceLabel: string; reason: string }>;
}

/**
 * Parse + map. Pure — input is the already-parsed JSON object (caller
 * runs JSON.parse / safeParseConfigJson). Returns both the importable
 * commands and an explanation of every skipped entry so the preview
 * shows the user why some tasks didn't survive.
 */
export function importTasksJson(parsed: unknown): ImportPreview {
	const imported: { command: ProjectCommand; sourceLabel: string }[] = [];
	const skipped: { sourceLabel: string; reason: string }[] = [];

	if (parsed === null || typeof parsed !== 'object') {
		return { imported, skipped: [{ sourceLabel: '<root>', reason: 'not-an-object' }] };
	}
	const root = parsed as { tasks?: unknown };
	if (!Array.isArray(root.tasks)) {
		return { imported, skipped: [{ sourceLabel: '<root>', reason: 'tasks-array-missing' }] };
	}

	const usedIds = new Set<string>();
	for (let i = 0; i < root.tasks.length; i++) {
		const item = root.tasks[i] as VsCodeTask | undefined;
		const sourceLabel = (item && typeof item.label === 'string' && item.label.length > 0)
			? item.label
			: `tasks[${i}]`;
		const result = mapOneTask(item, usedIds);
		if (!result.ok) {
			skipped.push({ sourceLabel, reason: result.reason });
			continue;
		}
		usedIds.add(result.value.id);
		imported.push({ command: result.value, sourceLabel });
	}
	return { imported, skipped };
}

function mapOneTask(
	task: VsCodeTask | undefined,
	usedIds: ReadonlySet<string>,
): { ok: true; value: ProjectCommand } | { ok: false; reason: string } {
	if (!task || typeof task !== 'object') {
		return { ok: false, reason: 'not-an-object' };
	}
	if (typeof task.label !== 'string' || task.label.length === 0) {
		return { ok: false, reason: 'label-missing' };
	}
	if (typeof task.command !== 'string' || task.command.length === 0) {
		return { ok: false, reason: 'command-missing' };
	}

	const id = makeUniqueId(task.label, usedIds);
	const args = Array.isArray(task.args)
		? task.args
			.map(a => typeof a === 'string' ? a : (a && typeof (a as { value?: unknown }).value === 'string' ? (a as { value: string }).value : ''))
			.filter(a => a.length > 0)
		: undefined;

	const cmd: ProjectCommand = {
		id,
		name: task.label,
		command: task.command,
	};
	if (args && args.length > 0) { cmd.args = args; }
	if (task.options?.cwd && typeof task.options.cwd === 'string') {
		cmd.cwd = task.options.cwd;
	}
	if (task.options?.env && typeof task.options.env === 'object') {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(task.options.env)) {
			if (typeof v === 'string') { env[k] = v; }
		}
		if (Object.keys(env).length > 0) { cmd.env = env; }
	}
	cmd.terminal = mapTerminalKind(task.type);
	return { ok: true, value: cmd };
}

function mapTerminalKind(type: VsCodeTask['type']): ProjectCommandTerminal {
	if (type === 'shell') { return 'integrated'; }
	if (type === 'process') { return 'integrated'; }
	return 'integrated';
}

/**
 * Build a `id` slug from the task label that matches PROJECT_COMMAND_ID_PATTERN.
 * Pure. Falls back to `task-N` and increments on collision.
 */
export function makeUniqueId(label: string, used: ReadonlySet<string>): string {
	const base = label
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		|| 'task';
	let candidate = PROJECT_COMMAND_ID_PATTERN.test(base) ? base : 'task';
	let n = 1;
	while (used.has(candidate)) {
		candidate = `${base.slice(0, 60 - String(n).length - 1)}-${n}`;
		n++;
	}
	return candidate;
}
