/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure helpers for chat-message timestamp formatting (H.5).
 * No `vscode` / `react` imports — usable from React render path and unit tests alike.
 *
 * Token alphabet: `YYYY MM DD HH mm ss` — fixed width, two digits for everything except year.
 * Unknown tokens are passed through verbatim (no throw on malformed pattern).
 */

const PAD2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/**
 * Format an absolute unix-ms timestamp as a fixed-width string. Locale-independent so
 * snapshot tests are stable across CI runners.
 *
 * Default pattern is `DD.MM.YYYY HH:mm` — matches the compact prefix shown next to
 * each chat message. Pass a custom pattern for tooltip / aria use.
 *
 * Returns the empty string for non-finite or non-numeric input. Negative timestamps
 * are formatted with the local-time interpretation that `Date` gives (callers should
 * filter pre-epoch values upstream if needed).
 */
export function formatChatTimestamp(ts: unknown, pattern: string = 'DD.MM.YYYY HH:mm'): string {
	if (typeof ts !== 'number' || !Number.isFinite(ts)) {
		return '';
	}
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) {
		return '';
	}
	const tokens: Record<string, string> = {
		YYYY: String(d.getFullYear()),
		MM: PAD2(d.getMonth() + 1),
		DD: PAD2(d.getDate()),
		HH: PAD2(d.getHours()),
		mm: PAD2(d.getMinutes()),
		ss: PAD2(d.getSeconds()),
	};
	return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, m => tokens[m] ?? m);
}

/**
 * Streaming placeholder string used before the first chunk arrives (assistant
 * messages only). Layout-stable: same character width as a real timestamp so the
 * surrounding text does not reflow when the actual time replaces the placeholder.
 */
export const CHAT_TIMESTAMP_STREAMING_PLACEHOLDER = '——.——.———— ——:——';

/**
 * ISO-8601 string for the `<time datetime="…">` attribute. Returns empty for
 * invalid input — caller should omit the attribute rather than emit `datetime=""`.
 */
export function chatTimestampToISO(ts: unknown): string {
	if (typeof ts !== 'number' || !Number.isFinite(ts)) {
		return '';
	}
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) {
		return '';
	}
	return d.toISOString();
}
