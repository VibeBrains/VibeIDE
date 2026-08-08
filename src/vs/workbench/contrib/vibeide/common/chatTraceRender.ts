/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Rendering of the chat-run timeline.
 *
 * Pure, and separate from the buffer, because the shape of this text is what a stall report is
 * read from — and reading one taught the lesson encoded here (03.08.2026, MiniMax-M3): retries
 * overlap, so a timeline can show
 *
 *   14:59:03 llmTurn:start
 *   14:59:04 llmTurn:hard-stall sec=120
 *
 * where the stall belongs to an attempt started two minutes earlier. Without saying whose timer
 * fired, the report reads as "the request that just started hung after one second" — the wrong
 * conclusion, drawn confidently.
 */

export interface ChatTraceEvent {
	/** epoch ms, for computing gaps between events */
	readonly atMs: number;
	/** wall-clock label in chat format (DD.MM.YYYY HH:mm:ss) */
	readonly ts: string;
	/** e.g. 'llmTurn:start', 'toolExec:done' */
	readonly kind: string;
	readonly detail: Readonly<Record<string, unknown>>;
}

/** Marker appended to an event belonging to an attempt that is no longer the current one. */
export const STALE_TURN_MARKER = '⟵ от прошлой попытки';

function formatDetail(detail: Readonly<Record<string, unknown>>): string {
	return Object.entries(detail)
		.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
		.join(', ');
}

/**
 * Renders events as a markdown timeline: the gap since the previous line, and — when attempts
 * overlap — a marker naming events that belong to a superseded attempt.
 */
export function renderChatTraceMarkdown(events: readonly ChatTraceEvent[]): string {
	if (events.length === 0) {
		return '# Chat Run Timeline\n\n_Трейс пуст — запустите запрос в чате, затем откройте таймлайн снова._\n';
	}
	const lines: string[] = ['# Chat Run Timeline', '', `Событий: ${events.length}`, ''];
	let prevMs = events[0].atMs;
	let currentTurn: number | undefined;
	for (const e of events) {
		const gapMs = e.atMs - prevMs;
		prevMs = e.atMs;
		const gap = gapMs >= 1000 ? `  _(+${(gapMs / 1000).toFixed(1)}s)_` : '';

		const turn = typeof e.detail.turn === 'number' ? e.detail.turn : undefined;
		if (e.kind === 'llmTurn:start' && turn !== undefined) {
			currentTurn = turn;
		}
		// Only older attempts are marked: an event with no turn (older builds, tool traces) is
		// left alone rather than guessed about.
		const stale = turn !== undefined && currentTurn !== undefined && turn < currentTurn
			? `  _${STALE_TURN_MARKER}_`
			: '';

		lines.push(`- \`${e.ts}\` **${e.kind}** ${formatDetail(e.detail)}${gap}${stale}`);
	}
	return lines.join('\n') + '\n';
}
