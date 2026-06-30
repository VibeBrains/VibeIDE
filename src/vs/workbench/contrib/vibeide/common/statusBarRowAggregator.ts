/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Unified VibeIDE status-bar — pure aggregator
 * (roadmap §"K.1 — Status bar overcrowding: свернуть в единый VibeIDE
 * indicator с popup-панелью; существующие 10+ контрибуций → API
 * `register status row` внутри popup").
 *
 * Pure helper — `vscode`-free — so the popup composition and the primary
 * badge text can be unit-tested without `IStatusbarService`. Existing
 * contributions migrate from `addEntry({…})` to
 * `IVibeUnifiedStatusBarService.registerRow({ id, label, tooltip, severity,
 * counter? })`; the unified contribution renders a single `VibeIDE` entry
 * whose text shows the highest-severity row's badge and whose hover popup
 * lists all rows in priority order.
 */

export type StatusRowSeverity = 'info' | 'success' | 'warn' | 'error';

export interface StatusRowDescriptor {
	readonly id: string;
	readonly label: string;
	readonly tooltip?: string;
	readonly severity?: StatusRowSeverity;
	/** Optional small numeric counter — e.g. running command count. */
	readonly counter?: number;
	/** Lower priority renders first in the popup; default = 100. */
	readonly priority?: number;
	/** When false the row is filtered out (allows feature flags). */
	readonly enabled?: boolean;
	/** Optional command id invoked from the popup quick-pick on this row. */
	readonly command?: string;
}

export interface UnifiedStatusBarSnapshot {
	readonly primary: {
		readonly text: string;
		readonly tooltip: string;
		readonly severity: StatusRowSeverity;
		readonly hidden: boolean;
	};
	readonly popupRows: readonly StatusRowDescriptor[];
}

const SEVERITY_RANK: Record<StatusRowSeverity, number> = {
	info: 0,
	success: 1,
	warn: 2,
	error: 3,
};

const SEVERITY_GLYPH: Record<StatusRowSeverity, string> = {
	info: '$(vibeide-logo)',
	success: '$(check)',
	warn: '$(warning)',
	error: '$(error)',
};

/**
 * Compose the unified status-bar snapshot.
 *
 *   - Filters out rows with `enabled === false`.
 *   - Sorts the popup by `priority` ascending (default 100), then by `id`
 *     for deterministic tie-break.
 *   - Primary badge severity = highest severity among enabled rows; if no
 *     rows are present, primary is hidden (so the bar stays clean when no
 *     VibeIDE features are active in the current workspace).
 *   - Primary text = `<glyph> VibeIDE` plus the highest-severity row's
 *     counter (if any), e.g. `$(warning) VibeIDE 3`.
 *   - Tooltip = `\n`-joined list of `label[: counter]` per popup row.
 */
export function buildUnifiedStatusBarSnapshot(rows: ReadonlyArray<StatusRowDescriptor>): UnifiedStatusBarSnapshot {
	const enabled = rows.filter(r => r.enabled !== false);
	if (enabled.length === 0) {
		return {
			primary: { text: '', tooltip: '', severity: 'info', hidden: true },
			popupRows: [],
		};
	}

	const sorted = [...enabled].sort((a, b) => {
		const pa = a.priority ?? 100;
		const pb = b.priority ?? 100;
		if (pa !== pb) { return pa - pb; }
		return a.id.localeCompare(b.id);
	});

	let topSeverity: StatusRowSeverity = 'info';
	let topCounter: number | undefined;
	for (const r of enabled) {
		const sev = r.severity ?? 'info';
		if (SEVERITY_RANK[sev] > SEVERITY_RANK[topSeverity]) {
			topSeverity = sev;
			topCounter = typeof r.counter === 'number' && Number.isFinite(r.counter) && r.counter > 0
				? Math.floor(r.counter)
				: undefined;
		}
	}

	const text = composeBadgeText(topSeverity, topCounter);
	const tooltip = sorted.map(r => formatPopupLine(r)).join('\n');

	return {
		primary: { text, tooltip, severity: topSeverity, hidden: false },
		popupRows: sorted,
	};
}

function composeBadgeText(severity: StatusRowSeverity, counter: number | undefined): string {
	const glyph = SEVERITY_GLYPH[severity];
	if (counter !== undefined) {
		return `${glyph} VibeIDE ${counter}`;
	}
	return `${glyph} VibeIDE`;
}

function formatPopupLine(r: StatusRowDescriptor): string {
	const tooltip = r.tooltip && r.tooltip.length > 0 ? ` — ${r.tooltip}` : '';
	if (typeof r.counter === 'number' && Number.isFinite(r.counter) && r.counter > 0) {
		return `• ${r.label}: ${Math.floor(r.counter)}${tooltip}`;
	}
	return `• ${r.label}${tooltip}`;
}

/**
 * Validate that two rows are not registered with the same `id` (single-id
 * invariant). Returns the offending id list (empty when clean).
 */
export function findDuplicateStatusRowIds(rows: ReadonlyArray<StatusRowDescriptor>): readonly string[] {
	const seen = new Set<string>();
	const dups = new Set<string>();
	for (const r of rows) {
		if (seen.has(r.id)) { dups.add(r.id); }
		seen.add(r.id);
	}
	return [...dups].sort();
}
