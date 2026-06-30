/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — registry-id formatter + keybindings label formatter
 * (roadmap §"Project Commands — Service / Keybindings").
 *
 * Pure helpers — `vscode`-free — so the dynamic-id derivation and the
 * `Keyboard Shortcuts` autofill label can be unit-tested without a workbench
 * harness.
 */

import { ProjectCommand, PROJECT_COMMAND_ID_PATTERN } from './projectCommandsTypes.js';

export const PROJECT_COMMAND_REGISTRY_PREFIX = 'vibeide.commands.run.';

/**
 * Compose the dynamic command id used by `CommandsRegistry` for keybindings
 * and the palette: `vibeide.commands.run.<id>`. Returns `null` for any input
 * that fails the strict id pattern — caller must refuse to register.
 */
export function commandIdToRegistryId(id: string): string | null {
	if (typeof id !== 'string' || !PROJECT_COMMAND_ID_PATTERN.test(id)) {
		return null;
	}
	return PROJECT_COMMAND_REGISTRY_PREFIX + id;
}

/**
 * Inverse of `commandIdToRegistryId`. Returns the `<id>` segment if the
 * registry id has the project-command prefix and the suffix is a valid id;
 * otherwise `null`.
 */
export function registryIdToCommandId(registryId: string): string | null {
	if (typeof registryId !== 'string' || !registryId.startsWith(PROJECT_COMMAND_REGISTRY_PREFIX)) {
		return null;
	}
	const suffix = registryId.slice(PROJECT_COMMAND_REGISTRY_PREFIX.length);
	if (!PROJECT_COMMAND_ID_PATTERN.test(suffix)) {
		return null;
	}
	return suffix;
}

/**
 * Human-readable label for the `Keyboard Shortcuts` UI autofill — roadmap §
 * "Keybindings → автозаполнение `vibeide.commands.run.<id>`".
 *
 * Format: `Project: <name>` (capitalised "Project" matches VS Code command
 * category convention; underscores/whitespace in `name` are preserved as
 * authored). Falls back to id when `name` is empty after trim.
 */
export function formatProjectCommandKeybindingLabel(command: Pick<ProjectCommand, 'id' | 'name'>): string {
	const name = typeof command.name === 'string' ? command.name.trim() : '';
	const display = name.length > 0 ? name : command.id;
	return `Project: ${display}`;
}

/**
 * Bulk variant for palette / Quick Pick rendering — preserves input order so
 * `sortProjectCommandsForDisplay` can sort first if the caller wants stable
 * display ordering.
 */
export function formatProjectCommandKeybindingLabels(
	commands: ReadonlyArray<Pick<ProjectCommand, 'id' | 'name'>>,
): readonly { readonly registryId: string; readonly label: string }[] {
	const out: { registryId: string; label: string }[] = [];
	for (const c of commands) {
		const registryId = commandIdToRegistryId(c.id);
		if (registryId === null) {
			continue;
		}
		out.push({ registryId, label: formatProjectCommandKeybindingLabel(c) });
	}
	return out;
}
