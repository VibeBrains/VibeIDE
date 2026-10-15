/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where a markdown text stands with respect to code: a fenced block, an inline code span
 *
 * Markup inside code is text the model wrote about markup, not a call: the readers of a call written as text
 * and the net that hides what they did not claim both ask this, so the question lives apart from either
 * Pure: a text in, a state out
 */

/** Marks a code fence: a run of ticks at the start of a line */
export const FENCE = '```';

/**
 * Where the text stands with respect to code, which markup inside is not a call: a fenced block, an inline code span
 * The state after a text is the state before the next piece of a stream
 */
export interface CodeState {
	readonly inFence: boolean;
	readonly inSpan: boolean;
	readonly atLineStart: boolean;
}

export const NO_CODE: CodeState = { inFence: false, inSpan: false, atLineStart: true };

/** The state after `text`: a fence opens a line (maybe indented), a run of ticks elsewhere opens or closes a span */
export function codeAfter(state: CodeState, text: string, end = text.length): CodeState {
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

/** Whether the character at `at` lies inside a fenced code block or an inline code span of `text` */
export function isInsideCode(text: string, at: number): boolean {
	const state = codeAfter(NO_CODE, text, at);
	return state.inFence || state.inSpan;
}
