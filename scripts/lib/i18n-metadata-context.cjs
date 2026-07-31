/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CJS port of `common/i18nMetadataContext.ts` for `scripts/vibe-nls-metadata-dump.mjs`.
// Shapes a Crowdin-compatible "context" field around the English source line
// snippet so translators see file:line + 2-3 lines of code next to each key.
//
// MUST stay in sync with src/vs/workbench/contrib/vibeide/common/i18nMetadataContext.ts.
// The .ts module's unit tests are the canonical regression coverage.

'use strict';

const MAX_SNIPPET_LINES = 3;
const MAX_SNIPPET_LINE_LEN = 200;

function formatSourceHeader(ctx) {
	const filePath = typeof ctx.filePath === 'string' ? ctx.filePath.trim() : '';
	if (filePath.length === 0) { return ''; }
	if (typeof ctx.lineNumber !== 'number' || !Number.isFinite(ctx.lineNumber) || ctx.lineNumber < 1) {
		return filePath;
	}
	return `${filePath}:${Math.floor(ctx.lineNumber)}`;
}

function formatSnippet(raw) {
	if (typeof raw !== 'string' || raw.length === 0) { return ''; }
	const lines = raw.replace(/\r\n/g, '\n').split('\n');
	while (lines.length > 0 && lines[0].trim() === '') { lines.shift(); }
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') { lines.pop(); }
	const clipped = lines.slice(0, MAX_SNIPPET_LINES).map((l) => {
		if (l.length <= MAX_SNIPPET_LINE_LEN) { return l; }
		return l.slice(0, MAX_SNIPPET_LINE_LEN) + '…';
	});
	return clipped.join('\n');
}

function dedupScreenshotNames(refs) {
	const seen = new Set();
	const out = [];
	for (const r of refs) {
		const name = typeof r.screenName === 'string' ? r.screenName.trim() : '';
		if (name.length === 0) { continue; }
		if (seen.has(name)) { continue; }
		seen.add(name);
		out.push(name);
	}
	return out;
}

/**
 * @param {{key:string, englishSource:string, sourceContext?:{filePath:string,lineNumber:number,snippet:string}, screenshots?:Array<{screenName:string,path:string}>}} input
 * @returns {{english:string, context:string}}
 */
function buildMetadataContextEntry(input) {
	const parts = [];

	if (input.sourceContext) {
		const head = formatSourceHeader(input.sourceContext);
		const snippet = formatSnippet(input.sourceContext.snippet);
		if (head.length > 0) { parts.push(head); }
		if (snippet.length > 0) { parts.push(snippet); }
	}

	if (input.screenshots && input.screenshots.length > 0) {
		const names = dedupScreenshotNames(input.screenshots);
		if (names.length > 0) {
			parts.push(`Screenshots: ${names.join(', ')}`);
		}
	}

	return {
		english: input.englishSource,
		context: parts.join('\n'),
	};
}

module.exports = { buildMetadataContextEntry };
