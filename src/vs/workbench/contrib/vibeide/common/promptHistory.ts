/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure helpers for the history of what the person typed into a prompt box (the chat composer, Ctrl+K Quick Edit):
 * recent submissions to step through with ↑/↓.
 * The storage is up to the caller — an opaque key-value store, so the same logic serves the memento of a window and a file.
 */

/** How many submissions a history keeps */
export const PROMPT_HISTORY_DEFAULT_MAX = 50;

/** A longer submission (a pasted log, a whole file) is not remembered: stepping back to it would flood the box, and storing it would swell the storage */
export const PROMPT_HISTORY_MAX_ENTRY_CHARS = 4000;

/** Where the chat composer's history lives: in the storage of the workspace, so each project keeps its own */
export const CHAT_PROMPT_HISTORY_STORAGE_KEY = 'vibeide.chat.promptHistory';

/** The history as it was stored; anything that is not a list of non-empty strings is dropped rather than trusted */
export function parsePromptHistory(raw: string | undefined, maxSize: number = PROMPT_HISTORY_DEFAULT_MAX): string[] {
	if (!raw) { return []; }
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) { return []; }
	return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).slice(-Math.max(1, maxSize));
}

/** Whether a submission is worth keeping in the history */
export function isRememberablePrompt(prompt: string): boolean {
	return prompt.trim().length > 0 && prompt.length <= PROMPT_HISTORY_MAX_ENTRY_CHARS;
}

/**
 * Whether ↑ or ↓ in a box with this text and caret walks the history instead of moving the caret
 * In a one-line box the keys have nothing else to do. In a several-line text they belong to the caret until it stands
 * on the first line (for ↑) or the last (for ↓), as in a terminal. A selection is the person's, and the keys leave it alone
 */
export function historyKeyApplies(text: string, selectionStart: number, selectionEnd: number, direction: -1 | 1): boolean {
	if (selectionStart !== selectionEnd) { return false; }
	return direction === -1 ? !text.slice(0, selectionStart).includes('\n') : !text.slice(selectionEnd).includes('\n');
}

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
	maxSize: number = PROMPT_HISTORY_DEFAULT_MAX,
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
