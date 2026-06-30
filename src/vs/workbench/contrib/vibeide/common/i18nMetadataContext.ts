/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * i18n metadata source-context attacher — pure helper
 * (roadmap §"Контекстные подсказки для переводчиков: в `metadata.json`
 * рядом с ключом сохраняем 2-3 строки исходника + путь к скриншоту (если
 * строка покрыта e2e). Crowdin использует это поле как «context»").
 *
 * Pure helper — `vscode`-free — caller does the file IO (extracting source
 * lines around the `localize()` call site, looking up screenshot paths from
 * the e2e coverage manifest). This module shapes those inputs into the
 * Crowdin-compatible context field.
 */

export interface SourceLineContext {
	readonly filePath: string;
	readonly lineNumber: number;
	/** 2-3 source lines around the `localize()` call. */
	readonly snippet: string;
}

export interface ScreenshotReference {
	readonly screenName: string;
	readonly path: string;
}

export interface MetadataContextInput {
	readonly key: string;
	readonly englishSource: string;
	readonly sourceContext?: SourceLineContext;
	readonly screenshots?: ReadonlyArray<ScreenshotReference>;
}

export interface MetadataContextEntry {
	readonly english: string;
	/**
	 * Crowdin-compatible context string: short prose summary that the
	 * translator sees alongside the key. Format:
	 *   `<file>:<line>\n<snippet>\nScreenshots: <list>`
	 * Empty when no source context and no screenshots.
	 */
	readonly context: string;
}

const MAX_SNIPPET_LINES = 3;
const MAX_SNIPPET_LINE_LEN = 200;

/**
 * Build the `metadata.json` value for one key. Pure — no IO, no Date.now.
 *
 * Caller is expected to have already truncated `englishSource` to a
 * reasonable length; this helper does NOT touch it.
 *
 * Snippet handling:
 *   - normalises CRLF → LF
 *   - clips to first 3 lines
 *   - clips each line to 200 chars (Crowdin context budget is small)
 *   - drops trailing/leading empty lines
 *
 * Screenshots:
 *   - de-duplicated by `screenName`
 *   - rendered as `Screenshots: <name1>, <name2>` joined with `, `
 *   - dropped if `screenName` is empty after trim
 */
export function buildMetadataContextEntry(input: MetadataContextInput): MetadataContextEntry {
	const parts: string[] = [];

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

function formatSourceHeader(ctx: SourceLineContext): string {
	const path = typeof ctx.filePath === 'string' ? ctx.filePath.trim() : '';
	if (path.length === 0) { return ''; }
	if (typeof ctx.lineNumber !== 'number' || !Number.isFinite(ctx.lineNumber) || ctx.lineNumber < 1) {
		return path;
	}
	return `${path}:${Math.floor(ctx.lineNumber)}`;
}

function formatSnippet(raw: string): string {
	if (typeof raw !== 'string' || raw.length === 0) { return ''; }
	const lines = raw.replace(/\r\n/g, '\n').split('\n');
	// Drop leading and trailing empty lines.
	while (lines.length > 0 && lines[0].trim() === '') { lines.shift(); }
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') { lines.pop(); }
	const clipped = lines.slice(0, MAX_SNIPPET_LINES).map(l => {
		if (l.length <= MAX_SNIPPET_LINE_LEN) { return l; }
		return l.slice(0, MAX_SNIPPET_LINE_LEN) + '…';
	});
	return clipped.join('\n');
}

function dedupScreenshotNames(refs: ReadonlyArray<ScreenshotReference>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
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
 * Bulk variant — given a list of metadata input rows, produce the
 * `key → entry` map ready to JSON-serialise as `vibeide.nls.metadata.json`.
 *
 * Pure: deterministic ordering preserves input order in the returned Map
 * (Map iteration order is insertion order). Caller can sort keys before
 * calling for stable on-disk output.
 */
export function buildMetadataIndex(
	rows: ReadonlyArray<MetadataContextInput>,
): ReadonlyMap<string, MetadataContextEntry> {
	const out = new Map<string, MetadataContextEntry>();
	for (const r of rows) {
		if (typeof r.key !== 'string' || r.key.length === 0) { continue; }
		out.set(r.key, buildMetadataContextEntry(r));
	}
	return out;
}
