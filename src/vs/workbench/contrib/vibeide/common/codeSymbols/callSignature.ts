/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RELATIVE_OWNERS, shortNameOf } from './nameConventions.js';

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
	/** Type the call is made on, when the source names one: `Invoice::pay(`. */
	owner?: string;
	/** The call goes through `$this`/`self`/`this` — the owner is the enclosing class. */
	readonly throughThis?: boolean;
}

/** Brackets that open and close nesting. A comma only separates when nesting is back to zero. */
const OPENERS: ReadonlySet<string> = new Set(['(', '[', '{']);
const CLOSERS: ReadonlySet<string> = new Set([')', ']', '}']);
const QUOTES: ReadonlySet<string> = new Set(['"', '\'', '`']);

/**
 * Walks text one character at a time, tracking what is inside a string and how deep the brackets go.
 *
 * Both readers below need exactly this and nothing more, but in opposite directions — forwards to
 * split a parameter list, backwards to find the call being typed. So the STATE is shared and the
 * direction is not: forcing one loop to serve both would cost more in indirection than the twelve
 * lines it saves.
 */
class NestingScanner {
	private _quote: string | undefined;
	depth = 0;

	/** @returns whether this character is ordinary text — not a quote, bracket, or inside a string. */
	step(char: string, previous: string | undefined): boolean {
		if (this._quote) {
			// An escaped quote does not close the string: `"a, \"b"` is one argument.
			if (char === this._quote && previous !== '\\') { this._quote = undefined; }
			return false;
		}
		if (QUOTES.has(char)) { this._quote = char; return false; }
		if (OPENERS.has(char)) { this.depth++; return false; }
		if (CLOSERS.has(char)) { this.depth--; return false; }
		return true;
	}
}

/**
 * The call whose argument list the cursor is inside, if any.
 *
 * @param lineText the whole line.
 * @param cursorColumn zero-based column of the cursor.
 */
export function activeCallAt(lineText: string, cursorColumn: number): ActiveCall | undefined {
	const text = lineText.slice(0, Math.max(0, cursorColumn));
	let argumentIndex = 0;
	// Scanned right to left: the call being typed is the nearest bracket left of the cursor that is
	// still open. Its own arguments are the commas passed on the way, at nesting level zero.
	let depth = 0;
	let quote: string | undefined;

	for (let i = text.length - 1; i >= 0; i--) {
		const char = text[i];

		if (quote) {
			// Backwards, a string ends where it began; the escape lives BEFORE the quote.
			if (char === quote && text[i - 1] !== '\\') { quote = undefined; }
			continue;
		}
		if (QUOTES.has(char)) { quote = char; continue; }
		if (CLOSERS.has(char)) { depth++; continue; }
		if (OPENERS.has(char)) {
			if (depth > 0) { depth--; continue; }
			if (char !== '(') {
				// An unclosed `[` or `{` means a list or a block, not a call.
				return undefined;
			}
			const callee = calleeBefore(text.slice(0, i));
			return callee ? { ...callee, argumentIndex } : undefined;
		}
		// Commas of nested calls belong to those calls, not to this one.
		if (char === ',' && depth === 0) { argumentIndex++; }
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

/**
 * The identifier immediately before the opening bracket, and what it is called on.
 *
 * `$this->pay(` → `pay` through `this`; `Invoice::pay(` → `pay` on `Invoice`. The owner is what lets
 * the signature of the RIGHT method be shown when several classes declare that name.
 */
function calleeBefore(text: string): { name: string; owner?: string; throughThis?: boolean } | undefined {
	const match = text.match(/([A-Za-z_][\w]*)\s*$/);
	if (!match) {
		return undefined;
	}
	const before = text.slice(0, text.length - match[0].length);
	const previousWord = before.match(/([A-Za-z_][\w]*)\s*$/)?.[1];
	if (previousWord && DECLARATION_KEYWORDS.has(previousWord.toLowerCase())) {
		return undefined;
	}
	const access = before.match(/([$@]?[\\\w]+)\s*(->|::|\.)\s*$/);
	if (!access) {
		return { name: match[1] };
	}
	const owner = access[1];
	if (RELATIVE_OWNERS.has(owner)) {
		return { name: match[1], throughThis: true };
	}
	// A lower-case owner is a variable whose type we cannot know; only a named type is useful here.
	const short = shortNameOf(owner);
	return /^[A-Z]/.test(short) ? { name: match[1], owner: short } : { name: match[1] };
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
	const scanner = new NestingScanner();
	let current = '';

	for (let i = 0; i < inner.length; i++) {
		const char = inner[i];
		const isPlain = scanner.step(char, inner[i - 1]);
		if (isPlain && char === ',' && scanner.depth === 0) {
			out.push(current.trim());
			current = '';
			continue;
		}
		current += char;
	}
	if (current.trim().length > 0) {
		out.push(current.trim());
	}
	return out;
}
