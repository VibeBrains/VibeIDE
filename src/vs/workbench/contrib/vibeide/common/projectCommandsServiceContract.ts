/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — `IVibeCustomCommandsService` contract: palette command
 * ids + event payload shapes
 * (roadmap §"Сервис и регистрация — IVibeCustomCommandsService" + "UX:
 * палитра").
 *
 * Pure module — `vscode`-free — exports the canonical command-ids and the
 * event payload validators so the runtime service skeleton can implement the
 * shape without re-deriving constants in two places. The actual service stays
 * in `browser/` and uses these shapes verbatim.
 */

import { ProjectCommand } from './projectCommandsTypes.js';

// -----------------------------------------------------------------------------
// Palette command ids (roadmap line 315)
// -----------------------------------------------------------------------------

export const PROJECT_COMMANDS_PALETTE_IDS = Object.freeze({
	run: 'vibeide.commands.runFromPalette',
	add: 'vibeide.commands.add',
	edit: 'vibeide.commands.edit',
	delete: 'vibeide.commands.delete',
	openJson: 'vibeide.commands.openConfigFile',
	revokeTrust: 'vibeide.commands.revokeTrust',
	importFromUrl: 'vibeide.commands.importFromUrl',
	resetOnboarding: 'vibeide.commands.resetOnboarding',
	pin: 'vibeide.commands.pin',
	unpin: 'vibeide.commands.unpin',
	cancel: 'vibeide.commands.cancel',
} as const);

export type ProjectCommandsPaletteId = typeof PROJECT_COMMANDS_PALETTE_IDS[keyof typeof PROJECT_COMMANDS_PALETTE_IDS];

const PALETTE_ID_SET: ReadonlySet<string> = new Set(Object.values(PROJECT_COMMANDS_PALETTE_IDS));

export function isProjectCommandsPaletteId(id: unknown): id is ProjectCommandsPaletteId {
	return typeof id === 'string' && PALETTE_ID_SET.has(id);
}

// -----------------------------------------------------------------------------
// Event payload shapes (roadmap line 310)
// -----------------------------------------------------------------------------

/** Emitted when the snapshot of available commands changes (FS-watch hit). */
export interface DidChangeCommandsEvent {
	readonly commands: readonly ProjectCommand[];
	/** Source of the change — useful for debugging / audit. */
	readonly source: 'fs-change' | 'manual-reload' | 'global-paths-change' | 'init';
}

/** Emitted when a command begins running (after confirm + pre-flight checks). */
export interface DidStartCommandEvent {
	readonly id: string;
	readonly name: string;
	readonly invocationId: string;
	readonly startedAtMs: number;
}

/** Emitted when a command finishes (success, failure, or cancellation). */
export interface DidEndCommandEvent {
	readonly id: string;
	readonly name: string;
	readonly invocationId: string;
	readonly endedAtMs: number;
	readonly outcome: 'success' | 'failure' | 'cancelled';
	readonly exitCode?: number;
	readonly durationMs?: number;
}

const NON_EMPTY_STR = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const FINITE_NUM = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Shape validator for `DidChangeCommandsEvent`. Returns `null` on any
 * malformation — caller can decide whether to log + skip or surface a banner.
 */
export function validateDidChangeCommandsEvent(raw: unknown): DidChangeCommandsEvent | null {
	if (!raw || typeof raw !== 'object') { return null; }
	const o = raw as Record<string, unknown>;
	if (!Array.isArray(o.commands)) { return null; }
	if (o.source !== 'fs-change' && o.source !== 'manual-reload' && o.source !== 'global-paths-change' && o.source !== 'init') { return null; }
	return { commands: o.commands as readonly ProjectCommand[], source: o.source };
}

export function validateDidStartCommandEvent(raw: unknown): DidStartCommandEvent | null {
	if (!raw || typeof raw !== 'object') { return null; }
	const o = raw as Record<string, unknown>;
	if (!NON_EMPTY_STR(o.id) || !NON_EMPTY_STR(o.name) || !NON_EMPTY_STR(o.invocationId)) { return null; }
	if (!FINITE_NUM(o.startedAtMs)) { return null; }
	return { id: o.id, name: o.name, invocationId: o.invocationId, startedAtMs: o.startedAtMs };
}

export function validateDidEndCommandEvent(raw: unknown): DidEndCommandEvent | null {
	if (!raw || typeof raw !== 'object') { return null; }
	const o = raw as Record<string, unknown>;
	if (!NON_EMPTY_STR(o.id) || !NON_EMPTY_STR(o.name) || !NON_EMPTY_STR(o.invocationId)) { return null; }
	if (!FINITE_NUM(o.endedAtMs)) { return null; }
	if (o.outcome !== 'success' && o.outcome !== 'failure' && o.outcome !== 'cancelled') { return null; }
	const exitCode = FINITE_NUM(o.exitCode) ? o.exitCode : undefined;
	const durationMs = FINITE_NUM(o.durationMs) && o.durationMs >= 0 ? o.durationMs : undefined;
	return {
		id: o.id,
		name: o.name,
		invocationId: o.invocationId,
		endedAtMs: o.endedAtMs,
		outcome: o.outcome,
		...(exitCode !== undefined ? { exitCode } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
	};
}

// -----------------------------------------------------------------------------
// Top-bar pinned filter (roadmap line 321)
// -----------------------------------------------------------------------------

export interface PinnedTopBarSlice {
	readonly pinned: readonly ProjectCommand[];
	readonly overflow: readonly ProjectCommand[];
}

/**
 * Partition the display-sorted command list into the pinned slice (top-bar
 * buttons) and the overflow tail (Quick Pick «…» menu). The split point is
 * `maxButtons`; default 6 matches the title-bar real estate before crowding.
 *
 * Caller passes the already-display-sorted list (call
 * `sortProjectCommandsForDisplay` first).
 */
export function pickTopBarPinned(
	displaySorted: ReadonlyArray<ProjectCommand>,
	maxButtons = 6,
): PinnedTopBarSlice {
	const cap = Math.max(0, Math.floor(maxButtons));
	const allPinned = displaySorted.filter(c => c.pinned === true);
	const pinned = allPinned.slice(0, cap);
	const overflow: ProjectCommand[] = [
		...allPinned.slice(cap),
		...displaySorted.filter(c => c.pinned !== true),
	];
	return { pinned, overflow };
}
