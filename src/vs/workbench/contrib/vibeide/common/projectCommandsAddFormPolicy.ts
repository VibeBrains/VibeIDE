/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — Settings → Workspace → Project Commands "Add new" form policy.
 *
 * Pure module (`vscode`-free) so the Add form's validation, draft→command
 * canonicalisation, JSON-preview generation, and commands.json mutations can be
 * unit-tested end-to-end without a workbench harness. The React panel in
 * `VibeWorkspaceForms.tsx` calls these helpers and then writes the result via
 * `IFileService`.
 */

import {
	ProjectCommand,
	ProjectCommandsFile,
	ProjectCommandTerminal,
	PROJECT_COMMAND_ID_PATTERN,
} from './projectCommandsTypes.js';

/** Raw form state — every field is a string so the inputs stay controlled. */
export interface AddCommandDraft {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly command: string;
	/** Newline-separated arg list — empty lines stripped. */
	readonly argsText: string;
	readonly cwd: string;
	readonly terminal: ProjectCommandTerminal | '';
	readonly pinned: boolean;
	/** Empty string ⇒ omit `order`. Otherwise parsed as finite integer. */
	readonly orderText: string;
}

export const ADD_COMMAND_DRAFT_EMPTY: AddCommandDraft = Object.freeze({
	id: '',
	name: '',
	description: '',
	command: '',
	argsText: '',
	cwd: '',
	terminal: '',
	pinned: false,
	orderText: '',
});

/**
 * Field-keyed validation errors. `null` means "valid (or empty optional)".
 * Caller renders the inline message under the field; aggregate `isValid`
 * derives from `!Object.values(errors).some(Boolean)`.
 */
export interface AddCommandValidation {
	readonly errors: {
		readonly id: string | null;
		readonly name: string | null;
		readonly command: string | null;
		readonly cwd: string | null;
		readonly order: string | null;
	};
	readonly isValid: boolean;
}

/** Reasons strings — kept in English (i18n key suffix). The UI maps to RU. */
export const ADD_COMMAND_ERROR = Object.freeze({
	idMissing: 'id-missing',
	idPattern: 'id-pattern',
	idDuplicate: 'id-duplicate',
	nameMissing: 'name-missing',
	commandMissing: 'command-missing',
	cwdAbsolute: 'cwd-absolute',
	cwdTraversal: 'cwd-traversal',
	orderNotNumber: 'order-not-number',
} as const);
export type AddCommandErrorCode = typeof ADD_COMMAND_ERROR[keyof typeof ADD_COMMAND_ERROR];

/**
 * Validate the draft against the strict decoder + workspace context (existing
 * command ids). Returns per-field error codes so the React layer can attach
 * messages without re-implementing the rules.
 */
export function validateAddCommandDraft(
	draft: AddCommandDraft,
	existingIds: ReadonlySet<string>,
): AddCommandValidation {
	const errors = {
		id: null as string | null,
		name: null as string | null,
		command: null as string | null,
		cwd: null as string | null,
		order: null as string | null,
	};

	const id = draft.id.trim();
	if (!id) {
		errors.id = ADD_COMMAND_ERROR.idMissing;
	} else if (!PROJECT_COMMAND_ID_PATTERN.test(id)) {
		errors.id = ADD_COMMAND_ERROR.idPattern;
	} else if (existingIds.has(id)) {
		errors.id = ADD_COMMAND_ERROR.idDuplicate;
	}

	if (!draft.name.trim()) {
		errors.name = ADD_COMMAND_ERROR.nameMissing;
	}

	if (!draft.command.trim()) {
		errors.command = ADD_COMMAND_ERROR.commandMissing;
	}

	const cwd = draft.cwd.trim();
	if (cwd.length > 0) {
		if (cwd.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cwd)) {
			errors.cwd = ADD_COMMAND_ERROR.cwdAbsolute;
		} else {
			const segments = cwd.split(/[\\/]+/);
			if (segments.some(s => s === '..')) {
				errors.cwd = ADD_COMMAND_ERROR.cwdTraversal;
			}
		}
	}

	const orderText = draft.orderText.trim();
	if (orderText.length > 0) {
		const n = Number(orderText);
		if (!Number.isFinite(n) || !Number.isInteger(n)) {
			errors.order = ADD_COMMAND_ERROR.orderNotNumber;
		}
	}

	const isValid = !errors.id && !errors.name && !errors.command && !errors.cwd && !errors.order;
	return { errors, isValid };
}

/**
 * Convert a validated draft into a clean `ProjectCommand`. Drops empty
 * optional fields so the produced JSON stays minimal — matches the on-disk
 * style of init-template output (no `description: ""`, no `args: []`).
 *
 * Precondition: caller has verified `validateAddCommandDraft(...).isValid`.
 * Behaviour on invalid input is undefined.
 */
export function buildProjectCommandFromDraft(draft: AddCommandDraft): ProjectCommand {
	const args = parseArgsText(draft.argsText);
	const cmd: ProjectCommand = {
		id: draft.id.trim(),
		name: draft.name.trim(),
		command: draft.command.trim(),
	};
	const description = draft.description.trim();
	if (description) { cmd.description = description; }
	if (args.length > 0) { cmd.args = args; }
	const cwd = draft.cwd.trim();
	if (cwd) { cmd.cwd = cwd; }
	if (draft.terminal === 'integrated' || draft.terminal === 'external' || draft.terminal === 'background') {
		cmd.terminal = draft.terminal;
	}
	if (draft.pinned) { cmd.pinned = true; }
	const orderText = draft.orderText.trim();
	if (orderText) {
		const n = Number(orderText);
		if (Number.isFinite(n) && Number.isInteger(n)) {
			cmd.order = n;
		}
	}
	return cmd;
}

/** Split argsText by newlines, trim, drop empty lines. */
export function parseArgsText(argsText: string): string[] {
	return argsText.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Serialise a single `ProjectCommand` as the JSON snippet the user will see
 * in the preview pane (pretty, tab indent, no trailing newline — preview only).
 */
export function previewProjectCommandJson(cmd: ProjectCommand): string {
	return JSON.stringify(cmd, null, '\t');
}

/**
 * Append `next` to `file.commands` and return the updated `ProjectCommandsFile`
 * plus the serialised text ready for `IFileService.writeFile`. Preserves
 * `vibeVersion` and the ordering of existing entries (the new one goes last).
 */
export function appendCommandToFile(
	file: ProjectCommandsFile,
	next: ProjectCommand,
): { file: ProjectCommandsFile; serialized: string } {
	const updated: ProjectCommandsFile = {
		vibeVersion: file.vibeVersion,
		commands: [...file.commands, next],
	};
	return { file: updated, serialized: serializeCommandsFile(updated) };
}

/**
 * Find a command by id in a file. Returns `null` when absent (e.g. the id
 * belongs to a global-source entry that isn't in the workspace file).
 */
export function findCommandById(
	file: ProjectCommandsFile,
	id: string,
): ProjectCommand | null {
	return file.commands.find(c => c.id === id) ?? null;
}

/**
 * Convert an existing `ProjectCommand` into a fully-populated draft suitable
 * for the edit form. Inverse of `buildProjectCommandFromDraft` for fields
 * actually shown in the UI; serialises args back to newline-separated text.
 */
export function commandToDraft(cmd: ProjectCommand): AddCommandDraft {
	return {
		id: cmd.id,
		name: cmd.name,
		description: cmd.description ?? '',
		command: cmd.command,
		argsText: (cmd.args ?? []).join('\n'),
		cwd: cmd.cwd ?? '',
		terminal: (cmd.terminal === 'integrated' || cmd.terminal === 'external' || cmd.terminal === 'background')
			? cmd.terminal
			: '',
		pinned: cmd.pinned === true,
		orderText: cmd.order === undefined ? '' : String(cmd.order),
	};
}

/**
 * Replace the command with id `id` in `file.commands` by the supplied
 * `updated` entry. The new entry takes the position of the old one — the
 * order isn't shuffled — so menubar / table reorderings stay stable across
 * edits.
 *
 * Returns `null` when the id isn't present (global-source command, race with
 * external delete, etc.); caller surfaces a warning.
 */
export function replaceCommandInFile(
	file: ProjectCommandsFile,
	id: string,
	updated: ProjectCommand,
): { file: ProjectCommandsFile; serialized: string } | null {
	const idx = file.commands.findIndex(c => c.id === id);
	if (idx < 0) { return null; }
	const next = [...file.commands];
	next[idx] = updated;
	const updatedFile: ProjectCommandsFile = {
		vibeVersion: file.vibeVersion,
		commands: next,
	};
	return { file: updatedFile, serialized: serializeCommandsFile(updatedFile) };
}

/**
 * Replace pinned-flag in-place for command id `id`. Returns `null` when the id
 * is not in the file (i.e. it came from a global path; caller must show the
 * "global-only" warning).
 */
export function setPinnedInFile(
	file: ProjectCommandsFile,
	id: string,
	pinned: boolean,
): { file: ProjectCommandsFile; serialized: string } | null {
	if (!file.commands.some(c => c.id === id)) { return null; }
	const updated: ProjectCommandsFile = {
		vibeVersion: file.vibeVersion,
		commands: file.commands.map(c => c.id === id ? { ...c, pinned } : c),
	};
	return { file: updated, serialized: serializeCommandsFile(updated) };
}

/**
 * Remove command with id `id`. Returns `null` when not present (global-only).
 */
export function removeCommandFromFile(
	file: ProjectCommandsFile,
	id: string,
): { file: ProjectCommandsFile; serialized: string } | null {
	if (!file.commands.some(c => c.id === id)) { return null; }
	const updated: ProjectCommandsFile = {
		vibeVersion: file.vibeVersion,
		commands: file.commands.filter(c => c.id !== id),
	};
	return { file: updated, serialized: serializeCommandsFile(updated) };
}

/**
 * Project convention: tab indent + trailing newline. Matches what
 * `serializeProjectCommandsInitTemplate` writes so the file stays diff-stable
 * after first-run init + user-driven Add.
 */
export function serializeCommandsFile(file: ProjectCommandsFile): string {
	return JSON.stringify(file, null, '\t') + '\n';
}
