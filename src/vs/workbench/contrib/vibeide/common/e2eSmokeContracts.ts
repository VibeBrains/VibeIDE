/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * E2E smoke contracts — pure invariant checkers for items that need a running
 * Electron host to fully verify but whose acceptance criteria can be specified
 * as pure rules now.
 *
 * Closes (as skeleton):
 *   - roadmap §505  qps-ploc smoke: 0 English remnants across screenshots
 *   - roadmap §522  --locale ru: 0 English in vibeide.* / sidebar / welcome
 *   - roadmap §523  --locale qps-ploc: 0 unbracketed VibeIDE strings
 *   - roadmap §524  --locale en: fallback works, 0 raw keys
 *   - roadmap §948  drag-drop chat tabs preserves chatId across split editor
 *   - roadmap §1065 multi-window scenario: lock file invariants
 *
 * The Playwright/automation layer that drives the IDE is stubbed elsewhere.
 * These helpers describe the acceptance shape so the test wiring is
 * trivial and the rules are unit-testable today.
 */

// -----------------------------------------------------------------------------
// Locale smoke (roadmap §505 + §522-524)
// -----------------------------------------------------------------------------

export type LocaleTag = 'ru' | 'en' | 'qps-ploc';

export interface LocaleSmokeFinding {
	readonly screen: 'sidebar' | 'welcome' | 'settings' | 'palette' | 'toast';
	readonly text: string;
	readonly reason: 'english-text' | 'raw-key' | 'placeholder-leak';
}

const RAW_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_.]*$/;
const QPS_PLOC_BRACKET_PATTERN = /^\[Å.*Å\]$/u; // `[Åb…cÅ]` simplified — qps-ploc bracket marker
const ENGLISH_HEURISTIC = /^[a-zA-Z][a-zA-Z\s.,!?'":;()-]+$/;

export function inspectLocaleScreens(
	locale: LocaleTag,
	visibleStrings: ReadonlyArray<{ screen: LocaleSmokeFinding['screen']; text: string }>,
): ReadonlyArray<LocaleSmokeFinding> {
	const findings: LocaleSmokeFinding[] = [];
	for (const { screen, text } of visibleStrings) {
		const trimmed = text.trim();
		if (trimmed.length === 0) { continue; }
		if (RAW_KEY_PATTERN.test(trimmed) && trimmed.includes('.')) {
			findings.push({ screen, text: trimmed, reason: 'raw-key' });
			continue;
		}
		if (locale === 'ru' && ENGLISH_HEURISTIC.test(trimmed) && !RAW_KEY_PATTERN.test(trimmed)) {
			findings.push({ screen, text: trimmed, reason: 'english-text' });
			continue;
		}
		if (locale === 'qps-ploc' && !QPS_PLOC_BRACKET_PATTERN.test(trimmed) && /[a-zA-Z]/.test(trimmed)) {
			findings.push({ screen, text: trimmed, reason: 'placeholder-leak' });
			continue;
		}
	}
	return findings;
}

// -----------------------------------------------------------------------------
// Tab drag-drop chatId invariant (roadmap §948)
// -----------------------------------------------------------------------------

export interface ChatTabSnapshot {
	readonly chatId: string;
	readonly groupId: number;
	readonly editorIndex: number;
}

export interface ChatTabDragResult {
	readonly preserved: boolean;
	readonly violations: ReadonlyArray<string>;
}

export function verifyChatTabDragInvariant(
	before: ReadonlyArray<ChatTabSnapshot>,
	after: ReadonlyArray<ChatTabSnapshot>,
): ChatTabDragResult {
	const violations: string[] = [];

	if (before.length !== after.length) {
		violations.push(`tab count changed: ${before.length} → ${after.length}`);
	}

	const beforeIds = new Set(before.map(t => t.chatId));
	const afterIds = new Set(after.map(t => t.chatId));
	for (const id of beforeIds) {
		if (!afterIds.has(id)) {
			violations.push(`chatId ${id} disappeared after drag`);
		}
	}
	for (const id of afterIds) {
		if (!beforeIds.has(id)) {
			violations.push(`unexpected chatId ${id} appeared after drag`);
		}
	}

	return { preserved: violations.length === 0, violations };
}

// -----------------------------------------------------------------------------
// Multi-window lock invariants (roadmap §1065)
// -----------------------------------------------------------------------------

export interface WindowLockSnapshot {
	readonly windowId: string;
	readonly heldLocks: ReadonlyArray<string>;
	readonly pid: number;
	readonly startedAtMs: number;
}

export interface MultiWindowLockResult {
	readonly ok: boolean;
	readonly violations: ReadonlyArray<string>;
}

export function verifyMultiWindowLockInvariants(
	windows: ReadonlyArray<WindowLockSnapshot>,
): MultiWindowLockResult {
	const violations: string[] = [];

	const lockToWindow = new Map<string, WindowLockSnapshot>();
	for (const w of windows) {
		for (const lock of w.heldLocks) {
			const existing = lockToWindow.get(lock);
			if (existing && existing.windowId !== w.windowId) {
				violations.push(`lock "${lock}" held by both ${existing.windowId} (pid ${existing.pid}) and ${w.windowId} (pid ${w.pid})`);
			}
			lockToWindow.set(lock, w);
		}
	}

	for (const w of windows) {
		if (w.pid <= 0) {
			violations.push(`window ${w.windowId} has invalid pid ${w.pid}`);
		}
		if (w.startedAtMs <= 0) {
			violations.push(`window ${w.windowId} has invalid startedAtMs ${w.startedAtMs}`);
		}
	}

	return { ok: violations.length === 0, violations };
}

// -----------------------------------------------------------------------------
// Sentinel for "test not yet wired"
// -----------------------------------------------------------------------------

export class E2ESmokeNotImplementedError extends Error {
	constructor(scenario: string) {
		super(
			`E2E smoke "${scenario}" pure contract is in place; ` +
			`Playwright/automation wiring landing under test/smoke/src/areas/* is the next step. ` +
			`See src/vs/workbench/contrib/vibeide/common/e2eSmokeContracts.ts.`,
		);
		this.name = 'E2ESmokeNotImplementedError';
	}
}
