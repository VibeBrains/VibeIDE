/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';

/** One VibeIDE command surfaced in the «VibeIDE Команды» window / any future command browser. */
export interface VibeCommandEntry {
	readonly id: string;
	readonly title: string;
	readonly category: string;
	readonly keybinding: string;
}

/** ILocalizedString | string → display string. */
const asText = (v: unknown): string =>
	typeof v === 'string' ? v
		: (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string')
			? (v as { value: string }).value
			: '';

/**
 * Clean a command title for the command-browser window, where each row renders as
 * «{category}: {title}». Many titles redundantly repeat the namespace ("VibeIDE: …",
 * "VibeIDE Plan: …", "Vibe Projects: …"), which produces an ugly double prefix / double colon
 * ("VibeIDE: VibeIDE: …", "VibeIDE: Vibe Projects: …"). When a category chip is present we:
 *   1) drop a leading "VibeIDE" the chip already shows, and
 *   2) turn a remaining "Sub: rest" namespace into a "[Sub] rest" tag (no second colon).
 * Commands without a category keep their "VibeIDE:" title prefix (it's their only namespace).
 */
function cleanTitle(title: string, category: string): string {
	if (!category) { return title; }
	let t = title.replace(/^VibeIDE\b\s*:?\s*/i, '');
	t = t.replace(/^(?:Vibe\s+)?([A-Za-zА-Яа-я][A-Za-zА-Яа-я0-9 ._/-]{0,22}?)\s*:\s+/, (_m, sub: string) => `[${sub.trim()}] `);
	return t.trim() || title;
}

/**
 * Single source of truth for "all VibeIDE commands": reads the canonical command registry
 * (`MenuRegistry` for the Command Palette — NOT a hand-maintained copy) and keeps the entries
 * whose id starts with `vibe`. Deduped by id, sorted by category then title. Every consumer
 * (the command-browser window, and anything added later) MUST go through here so the list never
 * drifts from what the palette actually exposes.
 */
export function collectVibeideCommands(keybindingService: IKeybindingService): VibeCommandEntry[] {
	const map = new Map<string, VibeCommandEntry>();
	for (const item of MenuRegistry.getMenuItems(MenuId.CommandPalette)) {
		const cmd = (item as { command?: { id?: unknown; title?: unknown; category?: unknown } }).command;
		const id = cmd?.id;
		if (typeof id !== 'string' || !id.startsWith('vibe') || map.has(id)) { continue; }
		const category = asText(cmd?.category);
		map.set(id, {
			id,
			title: cleanTitle(asText(cmd?.title), category),
			category,
			keybinding: keybindingService.lookupKeybinding(id)?.getLabel() ?? '',
		});
	}
	// '￿' sorts uncategorised entries last (after every real category).
	return [...map.values()].sort((a, b) =>
		(a.category || '￿').localeCompare(b.category || '￿') || a.title.localeCompare(b.title));
}
