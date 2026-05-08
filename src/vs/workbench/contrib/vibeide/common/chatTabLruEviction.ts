/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers for chat-tab LRU eviction (K.4 / 947).
 *
 * When a user tries to open a 6th tab and `vibeide.chat.maxOpenTabs` is 5,
 * the policy is "close the least-active tab and open the new one" — not
 * "block, you have too many tabs". The eviction decision is encoded here so
 * it can be unit-tested deterministically (no IDE state, no clock).
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface ChatTabSnapshot {
	/** Stable id (chatThreadId is the canonical mapping). */
	id: string;
	/** Last unix-ms when the tab was the active editor. */
	lastFocusedAt: number;
	/** True if the tab is currently focused. Focused tabs are never eviction candidates. */
	isFocused: boolean;
	/**
	 * True if the tab has unsent / streaming activity. Streaming tabs are
	 * never eviction candidates — closing them mid-stream wastes user wait time.
	 */
	isStreaming?: boolean;
	/**
	 * True if the tab is pinned (user explicitly clicked pin). Pinned tabs are
	 * never eviction candidates regardless of `lastFocusedAt`.
	 */
	isPinned?: boolean;
}

export type EvictionDecision =
	| { kind: 'evict'; tabId: string }
	| { kind: 'block'; reason: 'all-tabs-protected' | 'no-tabs' };

/**
 * Pick the tab to evict when opening a new one would exceed `maxOpenTabs`.
 *
 * Selection rules:
 *   1. Pinned / focused / streaming tabs are protected.
 *   2. Among the remaining, the tab with the smallest `lastFocusedAt` wins.
 *   3. Stable tie-break: insertion order (lower index in `tabs`).
 *
 * Returns `block` when *every* tab is protected — caller should surface a
 * "close a tab manually" notification rather than silently failing.
 */
export function pickTabToEvict(tabs: ReadonlyArray<ChatTabSnapshot>): EvictionDecision {
	if (tabs.length === 0) {
		return { kind: 'block', reason: 'no-tabs' };
	}

	let chosenIdx = -1;
	let chosen: ChatTabSnapshot | undefined;

	for (let i = 0; i < tabs.length; i++) {
		const tab = tabs[i];
		if (tab.isFocused || tab.isStreaming || tab.isPinned) {
			continue;
		}
		if (!chosen || tab.lastFocusedAt < chosen.lastFocusedAt) {
			chosen = tab;
			chosenIdx = i;
		}
	}

	if (!chosen) {
		return { kind: 'block', reason: 'all-tabs-protected' };
	}
	void chosenIdx; // retained for future logging hooks; selection itself is by lastFocusedAt
	return { kind: 'evict', tabId: chosen.id };
}

/**
 * Convenience: deciding `should I evict?` given a desired final count.
 *
 * `maxOpenTabs` is the user's setting. Returns `none` when the open list
 * already fits, `evict` with the chosen victim when one tab needs to close,
 * `block` when the policy can't proceed.
 */
export function decideOpenNewTab(
	currentTabs: ReadonlyArray<ChatTabSnapshot>,
	maxOpenTabs: number,
): { kind: 'none' } | EvictionDecision {
	if (!Number.isFinite(maxOpenTabs) || maxOpenTabs <= 0) {
		return { kind: 'block', reason: 'all-tabs-protected' };
	}
	if (currentTabs.length < maxOpenTabs) {
		return { kind: 'none' };
	}
	return pickTabToEvict(currentTabs);
}
