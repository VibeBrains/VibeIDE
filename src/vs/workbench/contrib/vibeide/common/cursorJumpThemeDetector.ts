/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Cursor-jump theme detector (1029) — pure heuristic.
 *
 * Cursor's "Tab to next edit" pattern: if the user makes 3 consecutive
 * edits with the same theme (rename, signature change), the IDE
 * predicts the *next* jump location and offers it via ghost text + Tab.
 *
 * This module spots the "same theme" pattern. Theming is by the rename's
 * old/new symbol pair: three jumps in a row touching the same identifier
 * pair count as "rename in progress, predict the next call site".
 *
 * vscode-free: no imports beyond standard lib.
 */

export type EditThemeKind = 'rename' | 'signature-change' | 'other';

export interface EditEvent {
	timestamp: number;
	fileUri: string;
	kind: EditThemeKind;
	/** For renames: the old identifier; for signature changes: the function name. */
	subject?: string;
	/** For renames: the new identifier (after edit). */
	subjectReplacement?: string;
}

export interface ThemeWindowConfig {
	/** Min consecutive matching events before "theme detected". Default 3. */
	consecutiveThreshold: number;
	/** Max ms between events for them to count as "consecutive". Default 5 min. */
	maxGapMs: number;
}

export const THEME_DEFAULTS: ThemeWindowConfig = {
	consecutiveThreshold: 3,
	maxGapMs: 5 * 60 * 1000,
};

export type ThemeSignal =
	| { kind: 'no-theme' }
	| { kind: 'theme-detected'; theme: 'rename' | 'signature-change'; subject: string; subjectReplacement?: string; eventCount: number };

/**
 * Walk the most recent events from the user's edit log and return whether
 * a coherent theme is in progress. Pure — caller passes the full event
 * list (caller bounds storage); the detector takes only the tail it needs.
 *
 * Algorithm:
 *   1. Walk events from newest to oldest.
 *   2. Skip 'other' kind (they don't break the streak — user might have
 *      pasted between renames; we only count theme-relevant events).
 *   3. Match against the head event's (kind, subject, subjectReplacement).
 *   4. Stop at first mismatch or when timestamp gap > maxGapMs.
 *   5. Emit theme-detected when count ≥ consecutiveThreshold.
 */
export function detectCursorJumpTheme(
	events: ReadonlyArray<EditEvent>,
	config: ThemeWindowConfig = THEME_DEFAULTS,
): ThemeSignal {
	if (events.length === 0) {
		return { kind: 'no-theme' };
	}
	// Find the newest theme-relevant event (rename or signature-change).
	let headIdx = -1;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].kind === 'rename' || events[i].kind === 'signature-change') {
			headIdx = i;
			break;
		}
	}
	if (headIdx < 0) {
		return { kind: 'no-theme' };
	}
	const head = events[headIdx];
	let count = 1;
	let lastTs = head.timestamp;
	for (let i = headIdx - 1; i >= 0; i--) {
		const e = events[i];
		if (e.kind === 'other') { continue; }
		if (e.kind !== head.kind) { break; }
		if (e.subject !== head.subject) { break; }
		if (e.subjectReplacement !== head.subjectReplacement) { break; }
		const gap = lastTs - e.timestamp;
		if (gap > config.maxGapMs) { break; }
		count++;
		lastTs = e.timestamp;
	}
	if (count >= config.consecutiveThreshold) {
		return {
			kind: 'theme-detected',
			theme: head.kind === 'rename' ? 'rename' : 'signature-change',
			subject: head.subject ?? '',
			subjectReplacement: head.subjectReplacement,
			eventCount: count,
		};
	}
	return { kind: 'no-theme' };
}

/**
 * Helper: bound the event log (only keep the tail relevant to the
 * detection window). Pure. Caller persists the trimmed log.
 */
export function trimEditLog(
	events: ReadonlyArray<EditEvent>,
	now: number,
	keepWindowMs: number = THEME_DEFAULTS.maxGapMs * 4,
): EditEvent[] {
	const cutoff = now - keepWindowMs;
	return events.filter(e => e.timestamp >= cutoff);
}
