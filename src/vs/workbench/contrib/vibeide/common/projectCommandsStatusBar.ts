/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — status-bar indicator formatter
 * (roadmap §"Status-bar индикатор «▶ N» (число запущенных команд)").
 *
 * Pure helper — `vscode`-free — so the format and the visibility decision can
 * be unit-tested without an `IStatusbarService`.
 */

export interface ProjectCommandsStatusBarState {
	readonly text: string;
	readonly visible: boolean;
	readonly tooltip: string;
}

/**
 * Format the status-bar entry for the project-commands "running" indicator.
 *
 * - `runningCount === 0` → entry hidden (no `▶ 0` clutter).
 * - `runningCount >= 1` → `▶ N` with RU tooltip listing names if provided.
 *
 * `runningCount` is clamped to `[0, +∞)`; non-finite / negative inputs render
 * as hidden so a runtime bug (e.g. accidental decrement) cannot produce
 * `▶ -1` or `▶ NaN`.
 */
export function buildProjectCommandsStatusBarState(input: {
	readonly runningCount: number;
	readonly runningNames?: ReadonlyArray<string>;
}): ProjectCommandsStatusBarState {
	const raw = input.runningCount;
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
		return { text: '', visible: false, tooltip: '' };
	}
	const n = Math.floor(raw);
	const text = `▶ ${n}`;
	const tooltip = buildTooltip(n, input.runningNames ?? []);
	return { text, visible: true, tooltip };
}

function buildTooltip(n: number, names: ReadonlyArray<string>): string {
	const header = n === 1
		? 'VibeIDE: 1 команда выполняется'
		: `VibeIDE: ${n} ${pluralCommands(n)} выполняются`;
	if (names.length === 0) {
		return header;
	}
	const cleaned = names.map(s => (typeof s === 'string' ? s.trim() : '')).filter(s => s.length > 0);
	if (cleaned.length === 0) {
		return header;
	}
	const max = 5;
	const shown = cleaned.slice(0, max);
	const overflow = cleaned.length > max ? `\n…ещё ${cleaned.length - max}` : '';
	return `${header}\n• ${shown.join('\n• ')}${overflow}`;
}

function pluralCommands(n: number): string {
	const lastTwo = n % 100;
	const last = n % 10;
	if (lastTwo >= 11 && lastTwo <= 14) { return 'команд'; }
	if (last === 1) { return 'команда'; }
	if (last >= 2 && last <= 4) { return 'команды'; }
	return 'команд';
}
