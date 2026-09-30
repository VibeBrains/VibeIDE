/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A tool call DeepSeek wrote into the text of its answer in its own markup (DSML) instead of the tool-call field
 *
 * The form follows the vendor's encoder (encoding_dsv32.py in huggingface.co/deepseek-ai/DeepSeek-V3.2):
 * `<｜DSML｜function_calls>` wraps `<｜DSML｜invoke name="…">`, which holds `<｜DSML｜parameter name="…" string="true|false">`
 * `string="true"` is the value as is, spaces and line breaks included; `string="false"` is JSON
 * The same markup also arrives with its markers gone and a space left after `<` and `</` (`< calls>`, `</ parameter>`)
 *
 * The contract is shared with VibeIDEA: `.vibe-defaults/testVectors/dsmlToolCalls.json`
 * The marker is the fullwidth `｜` only: an ASCII `|word|` inside a value is a shell pipe, not a marker
 */

export interface DsmlToolCall {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

export interface DsmlToolCalls {
	/** The text carries call markup */
	readonly markup: boolean;
	/** The markup parsed completely; a call cut off or a value that is not JSON fails the whole of it */
	readonly parsed: boolean;
	/** The calls in order; empty unless parsed */
	readonly calls: readonly DsmlToolCall[];
	/** The text without the markup, trimmed at the edges */
	readonly answer: string;
}

// `<`, an optional slash, the vendor marker or the space it left behind, then the tag name
const MARKER = '(?:｜{1,2}DSML｜{1,2})?';
const tagStart = (name: string, closing: boolean) => `<\\s*${closing ? '\\/' : ''}\\s*${MARKER}\\s*(?:${name})`;

const WRAPPER_NAMES = 'function_calls|calls';
const WRAPPER_OPEN_RE = new RegExp(`${tagStart(WRAPPER_NAMES, false)}\\s*>`, 'u');
const WRAPPER_CLOSE_RE = new RegExp(`${tagStart(WRAPPER_NAMES, true)}\\s*>`, 'u');
const INVOKE_OPEN_RE = new RegExp(`${tagStart('invoke', false)}\\s+name\\s*=\\s*"([^"]*)"\\s*>`, 'gu');
const INVOKE_CLOSE_RE = new RegExp(`${tagStart('invoke', true)}\\s*>`, 'u');
const PARAMETER_RE = new RegExp(
	`${tagStart('parameter', false)}\\s+name\\s*=\\s*"([^"]*)"(?:\\s+string\\s*=\\s*"(true|false)")?\\s*>([\\s\\S]*?)${tagStart('parameter', true)}\\s*>`,
	'gu',
);
const PARAMETER_OPEN_RE = new RegExp(`${tagStart('parameter', false)}\\b`, 'gu');

/** A tag begun at the end of a streamed chunk: `<`, `</`, `<｜DS`, `< inv`, `<｜DSML｜invoke name="x` */
const TRAILING_PARTIAL_RE = /<\s*\/?\s*[｜\p{L}_\s]*(?:\s+name\s*=\s*"[^"]*"?)?$/u;
/** Longest tail held back as a possible tag start — past it, the `<` is prose */
const MAX_PARTIAL_LENGTH = 64;

const NOT_MARKUP = (text: string): DsmlToolCalls => ({ markup: false, parsed: false, calls: [], answer: text.trim() });

/** Where the markup begins: the wrapper or the first call, whichever comes first; -1 without markup */
function markupStart(text: string): number {
	const wrapper = WRAPPER_OPEN_RE.exec(text)?.index ?? -1;
	INVOKE_OPEN_RE.lastIndex = 0;
	const invoke = INVOKE_OPEN_RE.exec(text)?.index ?? -1;
	if (wrapper < 0) { return invoke; }
	if (invoke < 0) { return wrapper; }
	return Math.min(wrapper, invoke);
}

export function parseDsmlToolCalls(text: string): DsmlToolCalls {
	const start = markupStart(text);
	if (start < 0) {
		return NOT_MARKUP(text);
	}
	const afterStart = text.slice(start);
	const close = WRAPPER_CLOSE_RE.exec(afterStart);
	const end = close ? start + close.index + close[0].length : text.length;
	const answer = (text.slice(0, start) + text.slice(end)).trim();
	const failed: DsmlToolCalls = { markup: true, parsed: false, calls: [], answer };

	const region = text.slice(start, end);
	const calls: DsmlToolCall[] = [];
	INVOKE_OPEN_RE.lastIndex = 0;
	let open: RegExpExecArray | null;
	while ((open = INVOKE_OPEN_RE.exec(region)) !== null) {
		const bodyStart = open.index + open[0].length;
		const closeTag = INVOKE_CLOSE_RE.exec(region.slice(bodyStart));
		if (!closeTag) {
			return failed;
		}
		const args = parseArguments(region.slice(bodyStart, bodyStart + closeTag.index));
		if (!args) {
			return failed;
		}
		calls.push({ name: open[1], arguments: args });
		INVOKE_OPEN_RE.lastIndex = bodyStart + closeTag.index + closeTag[0].length;
	}
	return calls.length > 0 ? { markup: true, parsed: true, calls, answer } : failed;
}

/** The parameters of one call, or undefined when a parameter is cut off or its JSON value does not parse */
function parseArguments(body: string): Record<string, unknown> | undefined {
	const args: Record<string, unknown> = {};
	let count = 0;
	PARAMETER_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PARAMETER_RE.exec(body)) !== null) {
		const [, name, isString, value] = match;
		count++;
		if (isString === 'false') {
			try {
				args[name] = JSON.parse(value.trim());
			} catch {
				return undefined;
			}
		} else {
			args[name] = value;
		}
	}
	// A parameter opened but never closed is a cut call, not an empty one
	const opened = body.match(PARAMETER_OPEN_RE)?.length ?? 0;
	return opened === count ? args : undefined;
}

/**
 * How much of a streamed text may be shown: everything before the markup, and before a tag that may be starting at the end
 * The held tail is short and bounded, so prose ending in `<` is only delayed until the next chunk
 */
export function dsmlVisibleLength(text: string): number {
	const start = markupStart(text);
	if (start >= 0) {
		return start;
	}
	const partial = TRAILING_PARTIAL_RE.exec(text);
	return partial && text.length - partial.index <= MAX_PARTIAL_LENGTH ? partial.index : text.length;
}
