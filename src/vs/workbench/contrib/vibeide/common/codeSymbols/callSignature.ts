/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reading a call being typed — pure, so it is testable without an editor.
 *
 * The question is narrow and entirely textual: standing inside `pay(1, |)`, which call is this and
 * which argument is the cursor on. Answered by scanning the line backwards and counting brackets,
 * because at this moment the code is INCOMPLETE — the closing bracket does not exist yet, so a
 * syntax tree of the line would be a tree of a parse error.
 */

export interface ActiveCall {
	/** Name of the callee, without the bracket. */
	readonly name: string;
	/** Zero-based index of the argument the cursor is on. */
	readonly argumentIndex: number;
}

/** Brackets and quotes that must be balanced before a comma or `(` counts. */
const CLOSERS: ReadonlyMap<string, string> = new Map([[')', '('], [']', '['], ['}', '{']]);
const OPENERS: ReadonlySet<string> = new Set(['(', '[', '{']);

/**
 * The call whose argument list the cursor is inside, if any.
 *
 * @param lineText the whole line.
 * @param cursorColumn zero-based column of the cursor.
 */
export function activeCallAt(lineText: string, cursorColumn: number): ActiveCall | undefined {
	const text = lineText.slice(0, Math.max(0, cursorColumn));
	let depth = 0;
	let argumentIndex = 0;
	let quote: string | undefined;

	for (let i = text.length - 1; i >= 0; i--) {
		const char = text[i];

		// Inside a string nothing counts — a comma there is text, not an argument separator.
		if (quote) {
			if (char === quote && text[i - 1] !== '\\') {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === '\'' || char === '`') {
			quote = char;
			continue;
		}
		if (CLOSERS.has(char)) {
			depth++;
			continue;
		}
		if (OPENERS.has(char)) {
			if (depth > 0) {
				depth--;
				continue;
			}
			if (char !== '(') {
				// An unclosed `[` or `{` means the cursor is in a list or a block, not in a call.
				return undefined;
			}
			const name = calleeBefore(text.slice(0, i));
			return name ? { name, argumentIndex } : undefined;
		}
		// Commas of nested calls belong to those calls, not to this one.
		if (char === ',' && depth === 0) {
			argumentIndex++;
		}
	}
	return undefined;
}

/**
 * Words that make the following name a DECLARATION rather than a call.
 *
 * Without this, writing `function pay(` pops up the parameter hint for the very method being
 * declared — help offered exactly where nobody asked for it. One list covers all seven languages:
 * a keyword that does not exist in a language simply never appears before a bracket there.
 */
const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
	'function', 'def', 'fn', 'func', 'sub', 'method', 'class', 'interface', 'trait', 'enum', 'struct', 'record',
]);

/** The identifier immediately before the opening bracket: `$this->pay` → `pay`. */
function calleeBefore(text: string): string | undefined {
	const match = text.match(/([A-Za-z_][\w]*)\s*$/);
	if (!match) {
		return undefined;
	}
	const before = text.slice(0, text.length - match[0].length);
	const previousWord = before.match(/([A-Za-z_][\w]*)\s*$/)?.[1];
	if (previousWord && DECLARATION_KEYWORDS.has(previousWord.toLowerCase())) {
		return undefined;
	}
	return match[1];
}

/**
 * Split a parameter list into its parameters, respecting nesting.
 *
 * `(array $rules = ["a", "b"], int $x)` must not break on the comma inside the default value, which
 * is why this is not `split(',')`.
 */
export function splitParameters(params: string): string[] {
	const inner = params.replace(/^\s*\(/, '').replace(/\)\s*$/, '');
	if (inner.trim().length === 0) {
		return [];
	}
	const out: string[] = [];
	let depth = 0;
	let quote: string | undefined;
	let current = '';

	for (let i = 0; i < inner.length; i++) {
		const char = inner[i];
		if (quote) {
			current += char;
			if (char === quote && inner[i - 1] !== '\\') { quote = undefined; }
			continue;
		}
		if (char === '"' || char === '\'' || char === '`') { quote = char; current += char; continue; }
		if (OPENERS.has(char)) { depth++; current += char; continue; }
		if (CLOSERS.has(char)) { depth--; current += char; continue; }
		if (char === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
		current += char;
	}
	if (current.trim().length > 0) {
		out.push(current.trim());
	}
	return out;
}
