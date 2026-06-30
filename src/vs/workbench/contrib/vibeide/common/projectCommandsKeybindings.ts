/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — default chord shortcut allocator
 * (roadmap §"Keybindings → дефолтные шорткаты для top-9 закреплённых:
 * `ctrl+shift+alt+1..9` под user-overridable `when: vibeide.commands.pinned >= N`").
 *
 * Pure helper — `vscode`-free — so the chord allocation can be unit-tested
 * without registering keybindings against the real `IKeybindingService`.
 */

import { ProjectCommand, sortProjectCommandsForDisplay } from './projectCommandsTypes.js';
import { commandIdToRegistryId } from './projectCommandsRegistryId.js';

export interface ProjectCommandDefaultChord {
	readonly registryId: string;
	readonly id: string;
	readonly key: string;
	/** Position 1..9 in the pinned-display order. */
	readonly slot: number;
	/** Suggested `when` clause for user-overridable defaults. */
	readonly when: string;
}

const CHORD_PREFIX = 'ctrl+shift+alt+';
const MAX_SLOTS = 9;

/**
 * Allocate `ctrl+shift+alt+1..9` to the first 9 pinned commands in display
 * order. Non-pinned commands and commands with invalid ids are skipped. Beyond
 * the 9-slot cap the rest is dropped (palette / Quick Pick remain available).
 *
 * `when` clause uses VS Code's standard pattern `vibeide.commands.pinned >= N`
 * so that user-overridable defaults fall through cleanly when fewer than N
 * pinned commands exist.
 */
export function allocateDefaultChords(commands: ReadonlyArray<ProjectCommand>): readonly ProjectCommandDefaultChord[] {
	const pinned = sortProjectCommandsForDisplay(commands).filter(c => c.pinned === true);
	const out: ProjectCommandDefaultChord[] = [];
	for (let i = 0; i < pinned.length && out.length < MAX_SLOTS; i++) {
		const c = pinned[i];
		const registryId = commandIdToRegistryId(c.id);
		if (registryId === null) {
			continue;
		}
		const slot = out.length + 1;
		out.push({
			registryId,
			id: c.id,
			key: CHORD_PREFIX + slot,
			slot,
			when: `vibeide.commands.pinned >= ${slot}`,
		});
	}
	return out;
}

export const DEFAULT_CHORD_PREFIX = CHORD_PREFIX;
export const DEFAULT_CHORD_MAX_SLOTS = MAX_SLOTS;
