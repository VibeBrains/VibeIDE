/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import type { ChatMessage } from './chatThreadServiceTypes.js';

export interface ThreadTrimResult {
	/** New messages array, bounded to ~target, with a trim marker (and pinned anchor) at the head. */
	readonly trimmed: ChatMessage[];
	/** How many oldest messages were dropped (what the trim marker reports). */
	readonly dropCount: number;
	/** The post-trim length target (cap - headroom). */
	readonly target: number;
	/** Whether the original task (first user message) was re-pinned at the head. */
	readonly pinnedAnchor: boolean;
}

/**
 * Pure thread-message trim. Bounds the in-memory/persisted message JSON so long
 * agent sessions don't OOM the renderer, WITHOUT losing the original task.
 *
 * Dropping the oldest messages naively scrolls the first user request out of the
 * thread, so after enough trims the model "forgets" what it was asked to do and
 * greets the user fresh as if the session were empty (model-stalls #012). To
 * prevent that, the FIRST user message (the task/goal) is re-pinned at the head
 * whenever it would otherwise fall inside the dropped range — never duplicated
 * (skipped when it already survives in the tail).
 *
 * Returns `null` when no trim is needed (length <= cap). `cap`/`headroom` are
 * clamped here so callers can pass raw config values.
 */
export function trimThreadMessages(messages: ChatMessage[], cap: number, headroom: number): ThreadTrimResult | null {
	const safeCap = Math.max(100, Math.min(5000, Math.floor(cap)));
	const safeHeadroom = Math.max(1, Math.min(safeCap - 1, Math.floor(headroom)));
	const target = Math.max(100, safeCap - safeHeadroom);
	if (messages.length <= safeCap) { return null; }

	const dropCount = messages.length - target;
	const firstUserIdx = messages.findIndex(m => m.role === 'user');
	const anchorMsg = (firstUserIdx >= 0 && firstUserIdx < dropCount) ? messages[firstUserIdx] : undefined;

	const trimMarker: ChatMessage = {
		role: 'assistant',
		displayContent: `_(${dropCount} earlier message${dropCount === 1 ? '' : 's'} trimmed from thread to keep memory bounded. Convert pipeline still summarises older context into each LLM request.)_`,
		reasoning: '',
		anthropicReasoning: null,
		createdAt: Date.now(),
	};

	const tail = messages.slice(dropCount);
	// Honor pin-context: keep any user-pinned message from the dropped head verbatim
	// (same treatment as the task anchor) so an explicit pin survives the hard thread
	// cap, not just budget-fill truncation. Exclude the anchor index to avoid a dup.
	const pinnedFromHead = messages
		.slice(0, dropCount)
		.filter((m, i) => (m as { pinned?: boolean }).pinned && i !== firstUserIdx);
	const head: ChatMessage[] = [];
	if (anchorMsg) { head.push(anchorMsg); }
	head.push(...pinnedFromHead, trimMarker);
	const trimmed = [...head, ...tail];
	return { trimmed, dropCount, target, pinnedAnchor: !!anchorMsg };
}

// ===================== tool-result SIZE capping =====================
// `trimThreadMessages` above bounds message COUNT. This bounds the SIZE of individual
// tool-results kept in the thread: a long session of large `read_file` / search / command
// outputs accumulates tens of MB of strings (heap dump of a real 97-thread store: `content`
// 11.3MB + `result.fileContents` 4.3MB), held live in the renderer AND re-serialized to disk.
// The newest `keepRecentFull` tool-results stay verbatim (the active turn + the LLM keepRecent
// window need them); older ones are head+tail-truncated with a marker. Re-running the tool
// restores the full output — this is a deliberate memory/history trade-off (roadmap).

/** Marker stitched into a size-capped stored tool-result. Russian (user sees it in the chat
 * history and export; the model also reads it as context). Reports the original KB so it is
 * clear how much was dropped and that re-running the tool restores it. */
const storedTruncationNote = (origChars: number): string =>
	`\n\n[…сохранённый результат усечён (${Math.round(origChars / 1024)} КБ) для экономии памяти — перезапусти инструмент, чтобы увидеть полный вывод…]\n\n`;

/** Head+tail truncate a single stored string to ~maxChars, keeping the informative start and
 * end (errors / run summaries often land at the tail). Returns the input unchanged if it fits. */
const truncateStored = (value: string, maxChars: number): string => {
	if (value.length <= maxChars) { return value; }
	const note = storedTruncationNote(value.length);
	const budget = Math.max(0, maxChars - note.length);
	const headLen = Math.ceil(budget * 0.6);
	const tailLen = budget - headLen;
	return value.slice(0, headLen) + note + (tailLen > 0 ? value.slice(value.length - tailLen) : '');
};

export interface CapToolResultsResult {
	/** New messages array (only changed messages are new objects; the rest are reused). */
	readonly messages: ChatMessage[];
	/** How many tool messages had at least one field truncated. */
	readonly cappedCount: number;
	/** Total characters removed across all fields. */
	readonly charsCut: number;
}

/**
 * Pure, immutable size-cap for tool-results in a single thread's messages. For every tool
 * message OLDER than the last `keepRecentFull` tool messages, truncate its `content` (the
 * LLM-facing string) and any oversized STRING field inside `result` (e.g. `read_file`'s
 * `fileContents`, a `tool_error` string), preserving the rest of the `result` object shape
 * so the UI/export keep reading their structured fields. Returns `null` when nothing exceeds
 * the threshold (caller keeps the original array — no needless re-render / re-serialize).
 *
 * `maxResultChars` is clamped to a sane floor so the cap can never be set so low that the
 * marker itself is the whole payload. `keepRecentFull` protects the freshest results, which
 * the active turn and the LLM keepRecent window still need verbatim.
 */
export function capToolResultSizes(
	messages: ChatMessage[],
	maxResultChars: number,
	keepRecentFull: number,
): CapToolResultsResult | null {
	const safeMax = Math.max(2000, Math.floor(maxResultChars));
	const safeKeep = Math.max(0, Math.floor(keepRecentFull));

	// Protect the last `safeKeep` tool messages (by position among tool messages).
	const toolIdxs: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'tool') { toolIdxs.push(i); }
	}
	const protectedIdx = new Set(toolIdxs.slice(Math.max(0, toolIdxs.length - safeKeep)));

	let cappedCount = 0;
	let charsCut = 0;
	let changed = false;

	const out = messages.map((m, i) => {
		if (m.role !== 'tool' || protectedIdx.has(i)) { return m; }
		const tm = m as Extract<ChatMessage, { role: 'tool' }>;
		let next: Extract<ChatMessage, { role: 'tool' }> = tm;
		let touched = false;

		// 1) `content` — the LLM-facing result string (the single biggest contributor).
		if (typeof tm.content === 'string' && tm.content.length > safeMax) {
			const capped = truncateStored(tm.content, safeMax);
			charsCut += tm.content.length - capped.length;
			next = { ...next, content: capped };
			touched = true;
		}

		// 2) `result` — string (tool_error) or object (success) with oversized string fields.
		const r: unknown = (next as { result?: unknown }).result;
		if (typeof r === 'string' && r.length > safeMax) {
			const capped = truncateStored(r, safeMax);
			charsCut += r.length - capped.length;
			const updated: unknown = { ...next, result: capped };
			next = updated as Extract<ChatMessage, { role: 'tool' }>;
			touched = true;
		} else if (r && typeof r === 'object') {
			let cappedObj: Record<string, unknown> | null = null;
			for (const k of Object.keys(r as Record<string, unknown>)) {
				const v = (r as Record<string, unknown>)[k];
				if (typeof v === 'string' && v.length > safeMax) {
					if (!cappedObj) { cappedObj = { ...(r as Record<string, unknown>) }; }
					const capped = truncateStored(v, safeMax);
					charsCut += v.length - capped.length;
					cappedObj[k] = capped;
				}
			}
			if (cappedObj) {
				const updated: unknown = { ...next, result: cappedObj };
				next = updated as Extract<ChatMessage, { role: 'tool' }>;
				touched = true;
			}
		}

		if (touched) { cappedCount++; changed = true; }
		return next;
	});

	return changed ? { messages: out, cappedCount, charsCut } : null;
}
