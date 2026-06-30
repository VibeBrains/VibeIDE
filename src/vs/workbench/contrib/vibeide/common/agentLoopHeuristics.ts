/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure heuristics shared by the agent loop and the context pipeline (roadmap section
 * "aggregator-failures", items F/G). Extracted from `chatThreadService.ts` and
 * `convertToLLMMessageService.ts` so the loop-breaking and truncation logic is unit-testable
 * without a running editor. No I/O, no services, no browser APIs.
 */

/**
 * Build a STABLE, order-independent signature for a tool call so the agent loop can detect
 * a call repeated verbatim (the deterministic re-read loop a model falls into when context
 * truncation has erased the prior result).
 *
 * - String `rawParams` (XML / raw transport) are used as-is.
 * - Object `rawParams` have their TOP-LEVEL keys sorted into a fresh object so `{a,b}` and
 *   `{b,a}` collapse to one signature. Nested values are kept verbatim (we deliberately do
 *   NOT use the `JSON.stringify(obj, keysArray)` allowlist form, which recursively drops
 *   nested keys). Nested key-order drift is rare for tool params and not worth a recursive sort.
 * - Anything unserializable (circular refs) falls back to a type-tagged stub so the call still
 *   gets a deterministic-per-type signature instead of throwing.
 */
export const toolCallSignature = (name: string, rawParams: unknown): string => {
	let serialized: string;
	try {
		if (typeof rawParams === 'string') {
			serialized = rawParams;
		} else if (rawParams && typeof rawParams === 'object') {
			const src = rawParams as Record<string, unknown>;
			const canonical: Record<string, unknown> = {};
			for (const k of Object.keys(src).sort()) { canonical[k] = src[k]; }
			serialized = JSON.stringify(canonical);
		} else {
			serialized = JSON.stringify(rawParams ?? {});
		}
	} catch {
		serialized = `[unserializable:${typeof rawParams}]`;
	}
	return `${name}::${serialized}`;
};

/**
 * Tool names whose VERBATIM repetition is almost always a genuine loop (re-running the same
 * shell command / NL command yields the same result), so they get a STRICTER (lower) anti-loop
 * threshold — block one repetition sooner.
 */
const STRICT_ANTI_LOOP_TOOLS: ReadonlySet<string> = new Set([
	'run_command',
	'run_persistent_command',
	'run_nl_command',
]);

/**
 * Tool names where a verbatim repeat is more often LEGITIMATE (e.g. re-reading a file to verify
 * an edit, re-applying an edit after a transient failure), so they get a more LENIENT (higher)
 * threshold — give the model an extra attempt before short-circuiting.
 */
const LENIENT_ANTI_LOOP_TOOLS: ReadonlySet<string> = new Set([
	'read_file',
	'edit_file',
	'rewrite_file',
]);

/** Floor for the strict bucket so an aggressive base (1) never blocks on the 2nd call outright. */
const STRICT_ANTI_LOOP_FLOOR = 2;

/**
 * Resolve the effective anti-loop repetition threshold for a specific tool (roadmap G extension:
 * per-tool thresholds). `base` is the user-configured `vibeide.chat.antiLoopRepeatThreshold`.
 *
 * - `base === 0` (guard disabled) → 0, always (never block).
 * - Strict tools → `max(STRICT_ANTI_LOOP_FLOOR, base - 1)` (block sooner).
 * - Lenient tools → `base + 1` (block later).
 * - Everything else → `base` (unchanged).
 *
 * Pure and deterministic; defaults preserve the global behavior for unlisted tools.
 */
export const resolveAntiLoopThreshold = (toolName: string, base: number): number => {
	if (base <= 0) { return 0; }
	if (STRICT_ANTI_LOOP_TOOLS.has(toolName)) { return Math.max(STRICT_ANTI_LOOP_FLOOR, base - 1); }
	if (LENIENT_ANTI_LOOP_TOOLS.has(toolName)) { return base + 1; }
	return base;
};

/**
 * Default for `vibeide.agent.autoContinueOnQuestion` — max CONSECUTIVE question-triggered
 * auto-continues (see `endsWithQuestion`). Under Autopilot a question-ending text turn is
 * ALWAYS nudged — independent of the regular `autoContinueMaxNudges` budget — because nobody
 * answers questions in unattended mode and the run would stall. The counter resets on every
 * executed tool call, like the regular nudge counter. `0` means unlimited (∞) — the toolbar
 * «подпин?» stepper exposes 0/5/10 presets next to this default.
 */
export const QUESTION_AUTO_CONTINUE_DEFAULT = 3;

/**
 * True when a model turn ends with a question — the last meaningful character is `?` (or
 * fullwidth `？`), allowing trailing whitespace and markdown/quote/bracket tails so that
 * `**Приступать?**`, `вопрос?»` and `(continue?)` all count. A question mark in the MIDDLE of
 * the text does not. Used by the Autopilot premature-stop handler: under unattended execution
 * a closing question («Приступать к реализации?») is a permission-seeking stall, not a real
 * request for input — the agent should decide and continue.
 */
export const endsWithQuestion = (text: string): boolean => {
	if (!text) { return false; }
	// Strip trailing whitespace + common markdown emphasis / quote / bracket tail characters.
	const trimmed = text.replace(/[\s*_`~"'»«)\]}>]+$/u, '');
	const last = trimmed.charAt(trimmed.length - 1);
	return last === '?' || last === '？';
};

/**
 * Terminal completion phrases for `looksLikeCompletionText`. Phrase-based (not bare ambiguous
 * single words) to limit false positives — these read as a CLOSING declaration of done-ness.
 */
const COMPLETION_SIGNALS: readonly string[] = [
	// Russian (primary — observed: MiniMax-M3 ends with «Завершаю.» / «Готово.»).
	// NOTE: object-taking past forms («завершил чтение», «завершено сканирование») are
	// deliberately excluded — they read as mid-task progress, not a terminal declaration.
	'готово', 'завершаю', 'работа завершена',
	'задача выполнена', 'задача решена', 'задача закрыта', 'готов к проверке',
	'всё готово', 'все готово', 'всё сделано', 'все сделано', 'всё закрыто', 'все закрыто',
	'все правки применены', 'всё реализовано', 'все реализовано',
	// English
	'task complete', 'task completed', 'all done', 'completed the task',
	'all changes applied', 'task is complete', 'task is done', 'work is complete',
];

/**
 * True when a model turn reads as a TERMINAL completion declaration — the model says it is done
 * («Готово», «Завершаю», «Задача выполнена», "task complete", …). Used ONLY by the Autopilot
 * premature-stop handler AFTER the nudge budget is exhausted, as a provider-independent safety
 * net for weak tool-callers (MiniMax/deepseek narrate completion in prose instead of emitting
 * the `vibe_complete` call). Looks at the TAIL of the turn (completion lands at the end) and is
 * phrase-based; residual false-positive risk is low because it only fires after repeated failed
 * nudges (a mid-task narration would have been nudged to continue and the model would have acted).
 */
export const looksLikeCompletionText = (text: string): boolean => {
	if (!text) { return false; }
	// Completion declarations land at the END — scope to the last ~200 chars, lowercased,
	// stripped of trailing markdown/quote/punctuation so «**Готово.**» and «Завершаю!» match.
	const tail = text.slice(-200).toLowerCase().replace(/[\s*_`~"'»«)\]}>.!]+$/u, '');
	return COMPLETION_SIGNALS.some(s => tail.includes(s));
};


/**
 * Budget-FILL tail selection for context truncation (roadmap F).
 *
 * Given per-message token estimates ordered oldest→newest and a token budget for the kept
 * tail, return the index of the FIRST message to KEEP. Everything before that index is the
 * overflow "head" the caller should summarize; everything from it onward is kept at full
 * fidelity. The newest messages are preferred (we grow the tail backward from the end).
 *
 * Invariant: at least the last message is always kept (a single message larger than the
 * budget is still retained — the caller's hard-cap pass elides oversized single messages).
 * If everything fits, returns 0 (keep all).
 */
export const pickBudgetFillTail = (messageTokens: readonly number[], tailBudget: number): number => {
	let keptStartIdx = messageTokens.length;
	let acc = 0;
	for (let i = messageTokens.length - 1; i >= 0; i--) {
		const t = messageTokens[i];
		if (acc + t > tailBudget && (messageTokens.length - i) > 1) { break; }
		acc += t;
		keptStartIdx = i;
	}
	return keptStartIdx;
};

/**
 * Budget-fill truncation plan that ALSO honors pinned messages (roadmap pin-context). Splits
 * the message list (oldest→newest, each `{ tokens, pinned? }`) into:
 *  - `keepIndices`  — kept VERBATIM, in original order: the recent budget-fit tail PLUS any
 *                     pinned message that falls in the older "head" (so important context
 *                     survives truncation regardless of age).
 *  - `summarizeIndices` — the remaining (older, non-pinned) head, to fold into <chat_summary>.
 *
 * The contiguous recent tail is chosen by `pickBudgetFillTail`; pinned head messages are then
 * lifted into the kept set. Order is preserved so chronology stays intact. Pure / deterministic.
 */
export const planBudgetFillTail = (
	messages: ReadonlyArray<{ tokens: number; pinned?: boolean }>,
	tailBudget: number
): { keepIndices: number[]; summarizeIndices: number[] } => {
	const keptStartIdx = pickBudgetFillTail(messages.map(m => m.tokens), tailBudget);
	const keepIndices: number[] = [];
	const summarizeIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (i >= keptStartIdx || messages[i].pinned) { keepIndices.push(i); }
		else { summarizeIndices.push(i); }
	}
	return { keepIndices, summarizeIndices };
};
