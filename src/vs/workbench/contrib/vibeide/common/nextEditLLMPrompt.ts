/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Next-edit LLM prompt builder — pure helper
 * (roadmap §"L.3.2 — Реальная LLM-интеграция в `VibeNextEditPredictionService`,
 * закрыть хвост «Phase 2: LLM integration» (предсказание следующей правки на
 * основе предыдущей; UX как Cursor «Tab to next edit»)").
 *
 * Pure helper — `vscode`-free. Companion to existing `nextEditGhostText.ts`
 * (which renders the prediction); this module produces the prompt that the
 * LLM consumes to GENERATE the prediction. The actual fetch/streaming
 * stays in the runtime adapter.
 *
 * Adoption order (in `vibeNextEditPredictionService`):
 *   1. observe last edit + cursor position
 *   2. call `buildNextEditPrompt(...)` to compose the LLM messages
 *   3. POST to provider (Ollama / lmstudio / cloud)
 *   4. parse response with `parseNextEditCompletion(...)`
 *   5. feed parsed candidates into `pickBestJumpCandidate` (existing helper)
 *   6. render with `buildNextEditGhostText` (existing helper)
 */

export interface EditWindowContext {
	readonly fileUri: string;
	readonly languageId: string;
	/** Lines around the cursor, including the cursor line. */
	readonly contextLines: readonly string[];
	readonly cursorLine0: number;
	readonly cursorColumn0: number;
}

export interface RecentEdit {
	readonly fileUri: string;
	readonly oldText: string;
	readonly newText: string;
	readonly atOffsetMs: number;
}

export interface NextEditPromptInput {
	readonly currentWindow: EditWindowContext;
	readonly lastEdit?: RecentEdit;
	readonly maxContextChars?: number;
	readonly modelHint?: 'fim' | 'chat';
}

export interface NextEditPromptResult {
	readonly systemPrompt: string;
	readonly userPrompt: string;
	readonly promptStyle: 'fim' | 'chat';
	readonly stopSequences: readonly string[];
}

const DEFAULT_MAX_CONTEXT_CHARS = 4000;
const FIM_PREFIX = '<|fim_prefix|>';
const FIM_SUFFIX = '<|fim_suffix|>';
const FIM_MIDDLE = '<|fim_middle|>';

/**
 * Build the LLM messages for next-edit prediction. Pure.
 *
 *   - `modelHint: 'fim'` — uses the standard FIM tokens (Ollama coder
 *     models, Codestral, etc); `userPrompt` is `<prefix>$PREFIX<suffix>$SUFFIX<middle>`.
 *   - `modelHint: 'chat'` — instructs a generic chat model with explicit
 *     "predict next edit" task and JSON-line response format.
 *   - default (no hint) → 'chat' (safer fallback).
 *
 * Stop sequences:
 *   - FIM models stop on `<|fim_suffix|>` boundary.
 *   - Chat models stop on `\n\n` or three newlines.
 */
export function buildNextEditPrompt(input: NextEditPromptInput): NextEditPromptResult {
	const style: 'fim' | 'chat' = input.modelHint ?? 'chat';
	const maxChars = clampMaxChars(input.maxContextChars);

	if (style === 'fim') {
		return buildFimPrompt(input, maxChars);
	}
	return buildChatPrompt(input, maxChars);
}

function clampMaxChars(raw: number | undefined): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 256) { return DEFAULT_MAX_CONTEXT_CHARS; }
	if (raw > 32_000) { return 32_000; }
	return Math.floor(raw);
}

function buildFimPrompt(input: NextEditPromptInput, maxChars: number): NextEditPromptResult {
	const { prefix, suffix } = splitContextAtCursor(input.currentWindow);
	const trimmedPrefix = trimToBudget(prefix, Math.floor(maxChars / 2), 'tail');
	const trimmedSuffix = trimToBudget(suffix, Math.floor(maxChars / 2), 'head');
	const userPrompt = `${FIM_PREFIX}${trimmedPrefix}${FIM_SUFFIX}${trimmedSuffix}${FIM_MIDDLE}`;
	return {
		systemPrompt: '',
		userPrompt,
		promptStyle: 'fim',
		stopSequences: [FIM_SUFFIX, FIM_PREFIX, FIM_MIDDLE],
	};
}

function buildChatPrompt(input: NextEditPromptInput, maxChars: number): NextEditPromptResult {
	const sys = [
		'You are a code-completion assistant predicting the *next edit* a developer will make,',
		'based on their most recent edit and the surrounding code context.',
		'',
		'Output exactly one line of JSON:',
		'  {"file": "<uri>", "lineDelta": <int>, "columnDelta": <int>, "insertion": "<text>"}',
		'',
		'Where:',
		'  - file is the URI to jump to (usually the same file)',
		'  - lineDelta + columnDelta are 0-based offsets from the current cursor',
		'  - insertion is the text to suggest (empty when only jumping)',
		'',
		'Do not include any prose, only the JSON line.',
	].join('\n');

	const lastEditBlock = input.lastEdit
		? `\nLast edit (${ageLabelMs(input.lastEdit.atOffsetMs)}):\n--- old ---\n${truncate(input.lastEdit.oldText, 800)}\n--- new ---\n${truncate(input.lastEdit.newText, 800)}\n`
		: '\nNo recent edit context.\n';

	const window = formatWindow(input.currentWindow, maxChars - lastEditBlock.length - 200);
	const userPrompt =
		`Language: ${input.currentWindow.languageId}\nFile: ${input.currentWindow.fileUri}\n\n` +
		`Cursor: line ${input.currentWindow.cursorLine0 + 1}, column ${input.currentWindow.cursorColumn0 + 1}\n` +
		lastEditBlock +
		'\nCurrent window:\n```\n' + window + '\n```\n\nPredict the next edit as a single JSON line.';

	return {
		systemPrompt: sys,
		userPrompt,
		promptStyle: 'chat',
		stopSequences: ['\n\n\n', '\n```\n'],
	};
}

function splitContextAtCursor(w: EditWindowContext): { prefix: string; suffix: string } {
	if (w.cursorLine0 < 0 || w.cursorLine0 >= w.contextLines.length) {
		return { prefix: w.contextLines.join('\n'), suffix: '' };
	}
	const before = w.contextLines.slice(0, w.cursorLine0).join('\n');
	const onLine = w.contextLines[w.cursorLine0] ?? '';
	const col = Math.max(0, Math.min(w.cursorColumn0, onLine.length));
	const prefixOnLine = onLine.slice(0, col);
	const suffixOnLine = onLine.slice(col);
	const after = w.contextLines.slice(w.cursorLine0 + 1).join('\n');
	const prefix = before.length > 0 ? `${before}\n${prefixOnLine}` : prefixOnLine;
	const suffix = after.length > 0 ? `${suffixOnLine}\n${after}` : suffixOnLine;
	return { prefix, suffix };
}

function trimToBudget(text: string, budget: number, keep: 'head' | 'tail'): string {
	if (text.length <= budget) { return text; }
	if (keep === 'head') { return text.slice(0, budget); }
	return text.slice(text.length - budget);
}

function formatWindow(w: EditWindowContext, budget: number): string {
	const joined = w.contextLines.join('\n');
	if (joined.length <= budget) { return joined; }
	// Keep the cursor line and roughly equal lines around it.
	const lines = w.contextLines;
	const cursor = w.cursorLine0;
	const above: string[] = [];
	const below: string[] = [];
	let used = (lines[cursor] ?? '').length + 1;
	for (let i = 1; i <= lines.length; i++) {
		const a = cursor - i;
		const b = cursor + i;
		if (a >= 0 && used + (lines[a].length + 1) < budget) {
			above.unshift(lines[a]);
			used += lines[a].length + 1;
		}
		if (b < lines.length && used + (lines[b].length + 1) < budget) {
			below.push(lines[b]);
			used += lines[b].length + 1;
		}
		if (used >= budget) { break; }
	}
	const center = lines[cursor] ?? '';
	return [...above, center, ...below].join('\n');
}

function truncate(s: string, n: number): string {
	if (s.length <= n) { return s; }
	return s.slice(0, n) + '…';
}

function ageLabelMs(ms: number): string {
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) { return '?'; }
	if (ms < 1000) { return `${ms}ms ago`; }
	if (ms < 60_000) { return `${Math.floor(ms / 1000)}s ago`; }
	return `${Math.floor(ms / 60_000)}m ago`;
}

// -----------------------------------------------------------------------------
// Response parser (LLM → typed candidate)
// -----------------------------------------------------------------------------

export interface NextEditCandidate {
	readonly fileUri: string;
	readonly lineDelta: number;
	readonly columnDelta: number;
	readonly insertion: string;
}

export type NextEditParseResult =
	| { readonly kind: 'ok'; readonly candidate: NextEditCandidate }
	| { readonly kind: 'no-json' }
	| { readonly kind: 'shape-mismatch'; readonly reason: string };

/**
 * Parse the LLM's chat-mode response into a typed `NextEditCandidate`.
 * Tolerates leading/trailing prose; extracts the first `{ ... }`-shaped
 * JSON object. Refuses non-finite deltas, missing required fields,
 * insertion that is not a string.
 */
export function parseNextEditCompletion(
	rawResponse: string,
	defaultFileUri?: string,
): NextEditParseResult {
	const json = extractFirstJsonObject(rawResponse);
	if (json === null) { return { kind: 'no-json' }; }
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { kind: 'no-json' };
	}
	if (!parsed || typeof parsed !== 'object') { return { kind: 'shape-mismatch', reason: 'root-not-object' }; }
	const o = parsed as Record<string, unknown>;
	const fileUri = typeof o.file === 'string' && o.file.length > 0 ? o.file : defaultFileUri;
	if (typeof fileUri !== 'string' || fileUri.length === 0) {
		return { kind: 'shape-mismatch', reason: 'file-missing' };
	}
	if (typeof o.lineDelta !== 'number' || !Number.isFinite(o.lineDelta) || !Number.isInteger(o.lineDelta)) {
		return { kind: 'shape-mismatch', reason: 'lineDelta-not-int' };
	}
	if (typeof o.columnDelta !== 'number' || !Number.isFinite(o.columnDelta) || !Number.isInteger(o.columnDelta)) {
		return { kind: 'shape-mismatch', reason: 'columnDelta-not-int' };
	}
	if (typeof o.insertion !== 'string') {
		return { kind: 'shape-mismatch', reason: 'insertion-not-string' };
	}
	return {
		kind: 'ok',
		candidate: { fileUri, lineDelta: o.lineDelta, columnDelta: o.columnDelta, insertion: o.insertion },
	};
}

function extractFirstJsonObject(s: string): string | null {
	const start = s.indexOf('{');
	if (start === -1) { return null; }
	let depth = 0;
	for (let i = start; i < s.length; i++) {
		if (s[i] === '{') { depth++; }
		else if (s[i] === '}') {
			depth--;
			if (depth === 0) { return s.slice(start, i + 1); }
		}
	}
	return null;
}
