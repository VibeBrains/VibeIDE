/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure helpers for the Ctrl+K Quick Edit prompt history (roadmap §"prompt
 * history"). Keeps recent submissions so the user can ↑/↓ through previous
 * prompts. UI wire-up reads + writes via these helpers; storage layer is
 * an opaque key-value store interface so the same logic works for memento
 * (browser) or file-backed (CLI) persistence.
 */

export const QUICK_EDIT_HISTORY_DEFAULT_MAX = 50;

/**
 * Append `prompt` to `history` with deduplication: if the new prompt equals
 * the most-recent entry it's a no-op; if it appears further back, the older
 * occurrence is removed before push (so the user sees it once, at the head).
 * Empty / whitespace-only prompts are rejected.
 *
 * Returns the new history (does not mutate input).
 */
export function appendPromptToHistory(
	history: readonly string[],
	newPrompt: string,
	maxSize: number = QUICK_EDIT_HISTORY_DEFAULT_MAX,
): string[] {
	if (typeof newPrompt !== 'string') { return [...history]; }
	const trimmed = newPrompt.trim();
	if (!trimmed) { return [...history]; }
	if (history.length > 0 && history[history.length - 1] === trimmed) {
		return [...history];
	}
	const filtered = history.filter(h => h !== trimmed);
	filtered.push(trimmed);
	const overshoot = filtered.length - Math.max(1, maxSize);
	if (overshoot > 0) { filtered.splice(0, overshoot); }
	return filtered;
}

export interface HistoryNavigationStep {
	readonly value: string | null;
	readonly newIndex: number;
}

/**
 * Move the cursor through history. `currentIndex === history.length` means
 * "current editing position, not yet in history" (default state). Direction
 * `-1` (Up) goes backwards in time; `+1` (Down) goes forward; bounds-checked.
 *
 * Returns `{ value, newIndex }`:
 *  - `value === null` → no further history in that direction; UI keeps text as-is.
 *  - `value === ''` → user navigated back to "current editing" state; UI restores
 *    the in-progress text (saved separately).
 *  - `value !== ''` → set textarea to this and move cursor to its end.
 */
export function navigateHistory(
	history: readonly string[],
	currentIndex: number,
	direction: -1 | 1,
): HistoryNavigationStep {
	if (history.length === 0) { return { value: null, newIndex: currentIndex }; }
	const clampedIdx = Math.max(0, Math.min(currentIndex, history.length));
	const nextIdx = clampedIdx + direction;

	if (direction === -1) {
		// Up — move toward older entries.
		if (nextIdx < 0) { return { value: null, newIndex: clampedIdx }; }
		return { value: history[nextIdx], newIndex: nextIdx };
	}
	// direction === 1, Down — move toward newer entries / present.
	if (nextIdx > history.length) { return { value: null, newIndex: clampedIdx }; }
	if (nextIdx === history.length) {
		// Past the most-recent entry → return-to-present marker.
		return { value: '', newIndex: history.length };
	}
	return { value: history[nextIdx], newIndex: nextIdx };
}
