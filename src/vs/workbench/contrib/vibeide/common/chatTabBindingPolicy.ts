/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helper for chat-tab ↔ thread binding lifecycle (K.4 / 944).
 *
 * When a chat thread is deleted while still open in a tab, the choice is
 * either strict 1:1 (close the tab with a warning toast) or "rebindable"
 * (offer the user a fresh thread, keep the tab). This module encodes the
 * decision so the runtime UI layer is just an interpreter.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type ThreadDeletePolicy = 'strict' | 'rebindable';

export interface OpenChatTab {
	tabId: string;
	boundThreadId: string;
	isFocused: boolean;
	hasUnsentDraft?: boolean;
}

export type DeletionAction =
	| { kind: 'close-tab'; tabId: string; reason: 'thread-deleted' }
	| { kind: 'unbind-tab'; tabId: string; reason: 'rebindable-policy' }
	| { kind: 'warn-close-blocked'; tabId: string; reason: 'unsent-draft' }
	| { kind: 'no-op' };

export interface DeletionDecisionInput {
	policy: ThreadDeletePolicy;
	deletedThreadId: string;
	openTabs: ReadonlyArray<OpenChatTab>;
}

/**
 * Decide what to do for every open tab when `deletedThreadId` is removed
 * from the thread store. Pure — returns the list of actions the runtime
 * applies in order.
 *
 * Rules:
 *   1. Tabs not bound to the deleted thread: no-op (preserves their state).
 *   2. Strict policy + bound tab + unsent draft: warn-close-blocked
 *      (the runtime should show a "save your draft first" prompt rather
 *      than nuke the input silently).
 *   3. Strict policy + bound tab without unsent draft: close-tab.
 *   4. Rebindable policy + bound tab: unbind-tab — the runtime offers a
 *      "create new thread" or "bind to recent thread" picker.
 */
export function decideOnThreadDeletion(input: DeletionDecisionInput): DeletionAction[] {
	const { policy, deletedThreadId, openTabs } = input;
	const actions: DeletionAction[] = [];
	for (const tab of openTabs) {
		if (tab.boundThreadId !== deletedThreadId) {
			continue;
		}
		if (policy === 'strict') {
			if (tab.hasUnsentDraft) {
				actions.push({ kind: 'warn-close-blocked', tabId: tab.tabId, reason: 'unsent-draft' });
			} else {
				actions.push({ kind: 'close-tab', tabId: tab.tabId, reason: 'thread-deleted' });
			}
		} else {
			actions.push({ kind: 'unbind-tab', tabId: tab.tabId, reason: 'rebindable-policy' });
		}
	}
	if (actions.length === 0) {
		return [{ kind: 'no-op' }];
	}
	return actions;
}

/**
 * Decide what to do when the runtime detects a "zombie" tab — bound to a
 * threadId that does not exist in the current thread map. Same shape as
 * `decideOnThreadDeletion` but for stale state surfaced after IDE restart.
 */
export function decideOnZombieTab(
	tab: OpenChatTab,
	knownThreadIds: ReadonlySet<string>,
	policy: ThreadDeletePolicy,
): DeletionAction {
	if (knownThreadIds.has(tab.boundThreadId)) {
		return { kind: 'no-op' };
	}
	if (policy === 'strict') {
		return tab.hasUnsentDraft
			? { kind: 'warn-close-blocked', tabId: tab.tabId, reason: 'unsent-draft' }
			: { kind: 'close-tab', tabId: tab.tabId, reason: 'thread-deleted' };
	}
	return { kind: 'unbind-tab', tabId: tab.tabId, reason: 'rebindable-policy' };
}
