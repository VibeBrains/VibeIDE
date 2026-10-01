/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TEXT_TOOL_CALL_FORMATS, TextToolCall, TextToolCallFormat, TextToolCallSchema } from './textToolCallFormats.js';

/**
 * A tool call the model wrote as text in its answer, in its family's own markup, instead of in the wire's field
 *
 * Every open model is trained on a chat template that writes calls in markup of its own, and the server is what turns
 * that markup into `tool_calls`: a server without the family's parser, or a model that slips, leaves the markup
 * in the answer. Read as the answer, it is shown as fragments and no tool runs
 *
 * Which markup it is follows from the text, not from the model's name: the same family stands behind many names and
 * many hosts, and DeepSeek's markup has come from a Qwen. What makes it a call is the request: it offered tools,
 * and the markup names one of them. Markup inside a code block, or naming no offered tool, is text the model meant
 *
 * The forms (`textToolCallFormats.ts`) are shared with VibeIDEA in `.vibe-defaults/testVectors/textToolCalls.json`
 * Pure: the text and the offered tools in, the calls and the answer around them out
 */

/**
 * - `calls`: the markup became calls of offered tools
 * - `unparsed`: markup that names an offered tool but does not read
 *   A call that failed: the model is asked to repeat it
 * - `text`: no call after all — no markup, markup in a code block, or markup that names no offered tool
 */
export type TextToolCallsOutcome = 'calls' | 'unparsed' | 'text';

export interface TextToolCallsRead {
	readonly outcome: TextToolCallsOutcome;
	/** Calls of offered tools, named as offered; empty unless the outcome is `calls` */
	readonly calls: readonly TextToolCall[];
	/** The text without the markup for calls, the words before it when unparsed, the whole text otherwise */
	readonly answer: string;
	/** The form the markup opened in, as the vectors name it; null when the text has none */
	readonly format: string | null;
}

/** Offered tool name → the JSON schema of its parameters */
export type OfferedToolSchemas = Readonly<Record<string, TextToolCallSchema | undefined>>;

const FENCE = '```';

/** Every literal a cut stream may be in the middle of: the openers and a code fence */
const WAIT_FOR: readonly string[] = [...TEXT_TOOL_CALL_FORMATS.flatMap(format => format.openers), FENCE];

/** Longest start of a tag worth waiting for: `<`, markers, spaces and a wrapper's name */
const TAG_PREFIX = 40;

/** How much of an answer that opens with `{` or `[` waits before it is surely not calls: a long tool name fits */
const ANSWER_OPENING = 80;

const PYTHON_START = '<|python_start|>';

/**
 * Where the text stands with respect to code, which markup inside is not a call: a fenced block, an inline code span
 * The state after a text is the state before the next piece of a stream
 */
interface CodeState {
	readonly inFence: boolean;
	readonly inSpan: boolean;
	readonly atLineStart: boolean;
}

const NO_CODE: CodeState = { inFence: false, inSpan: false, atLineStart: true };

/** The state after `text`: a fence opens a line (maybe indented), a run of ticks elsewhere opens or closes a span */
function codeAfter(state: CodeState, text: string, end = text.length): CodeState {
	let { inFence, inSpan, atLineStart } = state;
	let i = 0;
	while (i < end) {
		const c = text[i];
		if (c === '\n') {
			atLineStart = true;
			inSpan = false;
		} else if (atLineStart && (c === ' ' || c === '\t')) {
			// Indentation keeps the line's start
		} else if (c === '`') {
			let run = i;
			while (run < end && text[run] === '`') {
				run++;
			}
			if (atLineStart && run - i >= FENCE.length) {
				inFence = !inFence;
			} else if (!inFence) {
				inSpan = !inSpan;
			}
			atLineStart = false;
			i = run;
			continue;
		} else {
			atLineStart = false;
		}
		i++;
	}
	return { inFence, inSpan, atLineStart };
}

/** The format that opens first outside code, and where */
function firstOpening(text: string, code: CodeState, atAnswerStart: boolean): { readonly format: TextToolCallFormat; readonly at: number } | undefined {
	let best: { readonly format: TextToolCallFormat; readonly at: number } | undefined;
	for (const format of TEXT_TOOL_CALL_FORMATS) {
		let from = 0;
		while (true) {
			const at = format.open(text, from, atAnswerStart);
			if (at < 0 || (best && at >= best.at)) {
				break;
			}
			const after = codeAfter(code, text, at);
			if (!after.inFence && !after.inSpan) {
				best = { format, at };
				break;
			}
			from = at + 1;
		}
	}
	return best;
}

/** Where call markup starts in `text`, or -1; markup inside a code block or an inline code span is not a call */
export function textToolCallStart(text: string): number {
	return firstOpening(text, NO_CODE, true)?.at ?? -1;
}

/**
 * Length of the end of `text` that may still grow into an opener or a fence: it waits for the next piece
 * A `<` not yet closed by `>` waits too: markup whose markers were lost opens with `<` and a space
 */
function openTail(text: string): number {
	let keep = 0;
	for (const literal of WAIT_FOR) {
		// A whole opener waits too: several are only the head of what the format's pattern needs
		for (let length = Math.min(literal.length, text.length); length > keep; length--) {
			if (text.endsWith(literal.slice(0, length))) {
				keep = length;
				break;
			}
		}
	}
	const lt = text.lastIndexOf('<');
	if (lt >= 0 && text.indexOf('>', lt) < 0 && text.length - lt <= TAG_PREFIX) {
		keep = Math.max(keep, text.length - lt);
	}
	return keep;
}

/** Whether the answer so far, blanks aside, opens like the forms that are the whole answer and is still short */
function mayOpenAnswer(text: string): boolean {
	const opening = text.trimStart();
	if (opening.length > ANSWER_OPENING) {
		return false;
	}
	return opening.length === 0 || opening[0] === '{' || opening[0] === '[' || PYTHON_START.startsWith(opening.slice(0, PYTHON_START.length));
}

const FUNCTIONS_PREFIX = 'functions.';
const NAMESPACE_SEPARATOR = '::';

/**
 * The offered tool `name` means, or undefined
 * Matched as written, then without `functions.` (Kimi, harmony) and without the `namespace::` of DeepSeek V4.1
 * Own names only: a name such as `constructor` must not match what every object inherits
 */
function resolveTool(name: string, offered: OfferedToolSchemas): string | undefined {
	const bare = name.startsWith(FUNCTIONS_PREFIX) ? name.slice(FUNCTIONS_PREFIX.length) : name;
	const separator = name.lastIndexOf(NAMESPACE_SEPARATOR);
	const local = separator < 0 ? name : name.slice(separator + NAMESPACE_SEPARATOR.length);
	return [name, bare, local].find(candidate => Object.hasOwn(offered, candidate));
}

/**
 * The whole answer read for calls to the `offered` tools, each name with its parameters' JSON schema
 * A call to a tool that was not offered is the model writing about one, not calling it
 */
export function parseTextToolCalls(text: string, offered: OfferedToolSchemas): TextToolCallsRead {
	const opening = firstOpening(text, NO_CODE, true);
	if (!opening) {
		return { outcome: 'text', calls: [], answer: text, format: null };
	}
	const before = text.slice(0, opening.at);
	const markup = text.slice(opening.at);
	const schemas = (tool: string) => {
		const name = resolveTool(tool, offered);
		return name === undefined ? undefined : offered[name];
	};
	const atAnswerStart = before.trim().length === 0;
	// Formats that share an opener (`<tool_call>` opens several families) are told apart by what reads
	const candidates = [opening.format, ...TEXT_TOOL_CALL_FORMATS.filter(format => format !== opening.format && format.open(markup, 0, atAnswerStart) === 0)];
	for (const format of candidates) {
		const found = format.read(markup, schemas);
		if (!found) {
			continue;
		}
		const calls: TextToolCall[] = [];
		for (const call of found.calls) {
			const name = resolveTool(call.name, offered);
			if (name === undefined) {
				return { outcome: 'text', calls: [], answer: text, format: format.id };
			}
			calls.push({ name, arguments: call.arguments });
		}
		return { outcome: 'calls', calls, answer: (before + found.rest).trim(), format: format.id };
	}
	// Markup that names none of the tools is the model writing about markup, not calling
	if (!Object.keys(offered).some(tool => markup.includes(tool))) {
		return { outcome: 'text', calls: [], answer: text, format: opening.format.id };
	}
	return { outcome: 'unparsed', calls: [], answer: before.trim(), format: opening.format.id };
}

/**
 * Holds back the part of a streamed answer that turned out to be call markup
 *
 * The markup has to be caught before it reaches the reader, and it arrives cut between chunks: text that is surely not
 * markup goes on at once, a tail that may still become an opener waits for the next chunk, and from the first opener
 * outside code everything is held for the end of the answer
 * Only the unsent part is searched on each chunk, so a long answer is not read again and again
 */
export class TextToolMarkupFilter {
	private pending = '';
	private holding = false;
	private code = NO_CODE;
	private atAnswerStart = true;
	private shownText = '';

	/** The part of the answer that is surely not markup */
	get shown(): string {
		return this.shownText;
	}

	accept(delta: string): void {
		if (!delta) {
			return;
		}
		this.pending += delta;
		if (this.holding) {
			return;
		}
		const opening = firstOpening(this.pending, this.code, this.atAnswerStart);
		if (opening) {
			this.emit(this.pending.slice(0, opening.at));
			this.pending = this.pending.slice(opening.at);
			this.holding = true;
			return;
		}
		// An answer that opens like JSON or a list may still become calls: it waits until it has said enough to tell
		if (this.atAnswerStart && mayOpenAnswer(this.pending)) {
			return;
		}
		const keep = openTail(this.pending);
		if (keep < this.pending.length) {
			this.emit(this.pending.slice(0, this.pending.length - keep));
			this.pending = this.pending.slice(this.pending.length - keep);
		}
	}

	/** The held markup, or undefined when the answer had none; with none, the last tail goes out as text */
	finish(): string | undefined {
		const rest = this.pending;
		this.pending = '';
		if (this.holding) {
			return rest;
		}
		this.emit(rest);
		return undefined;
	}

	private emit(text: string): void {
		if (!text) {
			return;
		}
		this.code = codeAfter(this.code, text);
		this.atAnswerStart = this.atAnswerStart && text.trim().length === 0;
		this.shownText += text;
	}
}
