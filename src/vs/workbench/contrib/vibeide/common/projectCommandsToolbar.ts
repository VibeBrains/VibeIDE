/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — toolbar position decoder + context-menu action enum
 * (roadmap §"Project Commands — Top-bar UI / Контекст-меню кнопки").
 *
 * Pure helpers — `vscode`-free — so the configuration validation and the
 * context-menu action contract can be unit-tested without a workbench harness.
 */

export type ProjectCommandsToolbarPosition = 'titlebar' | 'statusbar' | 'hidden';

export const PROJECT_COMMANDS_TOOLBAR_POSITIONS: readonly ProjectCommandsToolbarPosition[] = Object.freeze(
	['titlebar', 'statusbar', 'hidden'] as const,
);

export const PROJECT_COMMANDS_TOOLBAR_DEFAULT: ProjectCommandsToolbarPosition = 'titlebar';

/**
 * Decode `vibeide.commands.toolbar.position` setting value. Falls back to the
 * documented default for any malformed / unknown value — caller never sees a
 * thrown error.
 */
export function decodeProjectCommandsToolbarPosition(raw: unknown): ProjectCommandsToolbarPosition {
	if (typeof raw !== 'string') {
		return PROJECT_COMMANDS_TOOLBAR_DEFAULT;
	}
	const trimmed = raw.trim().toLowerCase();
	for (const allowed of PROJECT_COMMANDS_TOOLBAR_POSITIONS) {
		if (trimmed === allowed) {
			return allowed;
		}
	}
	return PROJECT_COMMANDS_TOOLBAR_DEFAULT;
}

/**
 * Whether the toolbar should be rendered at all. `hidden` means the user
 * opted out — palette / keybindings / status-bar `▶ N` indicator stay live.
 */
export function isToolbarVisible(position: ProjectCommandsToolbarPosition): boolean {
	return position !== 'hidden';
}

// -----------------------------------------------------------------------------
// Context-menu actions on a top-bar button (roadmap line 323)
// -----------------------------------------------------------------------------

export type ProjectCommandsContextMenuAction =
	| 'run'
	| 'edit'
	| 'unpin'
	| 'delete'
	| 'copy-command-line';

export const PROJECT_COMMANDS_CONTEXT_MENU_ORDER: readonly ProjectCommandsContextMenuAction[] = Object.freeze([
	'run',
	'edit',
	'unpin',
	'delete',
	'copy-command-line',
] as const);

/**
 * Filter context-menu actions for a specific button state. Hides actions that
 * are not applicable: `unpin` requires `pinned: true`; `delete` is hidden for
 * commands marked `protected: true` (reserved for built-in / global ones).
 */
export function visibleContextMenuActions(state: {
	readonly pinned: boolean;
	readonly protected?: boolean;
}): readonly ProjectCommandsContextMenuAction[] {
	const out: ProjectCommandsContextMenuAction[] = [];
	for (const action of PROJECT_COMMANDS_CONTEXT_MENU_ORDER) {
		if (action === 'unpin' && !state.pinned) {
			continue;
		}
		if (action === 'delete' && state.protected) {
			continue;
		}
		out.push(action);
	}
	return out;
}

/**
 * Decode an action string coming from the UI dispatcher. Returns `null` for
 * unknown values so callers can refuse to act instead of silently ignoring.
 */
export function decodeContextMenuAction(raw: unknown): ProjectCommandsContextMenuAction | null {
	if (typeof raw !== 'string') {
		return null;
	}
	for (const allowed of PROJECT_COMMANDS_CONTEXT_MENU_ORDER) {
		if (raw === allowed) {
			return allowed;
		}
	}
	return null;
}
