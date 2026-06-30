/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * AI provenance block detector (roadmap §L1179) — pure helper.
 *
 * Scans a file's text for `@ai-generated <modelId> <isoTimestamp>` markers
 * (produced by `formatProvenanceMarker` in `vibeAiProvenanceConfiguration.ts`).
 * Each marker opens an "AI block" that extends down to the next blank line
 * or another marker. Editor contribution turns these spans into gutter +
 * overview-ruler decorations and a hover so reviewers can see which code
 * came out of an agent.
 *
 * Pure: no monaco / IFileService / vscode imports.
 */

const MARKER_RE = /@ai-generated\s+(\S+)\s+(\S+)/;

export interface ProvenanceBlock {
	/** 1-based line number of the marker comment itself. */
	readonly markerLine: number;
	/** 1-based line number of the first non-marker line in the block. */
	readonly blockStart: number;
	/** 1-based line number of the last line in the block (inclusive). */
	readonly blockEnd: number;
	readonly modelId: string;
	readonly timestamp: string;
}

/**
 * Detect provenance blocks in `lines`. A block opens on every marker line
 * and runs until the next blank line or the next marker (whichever comes
 * first), or end-of-file. Marker-only files (marker is the very last line
 * with no body) are emitted with `blockStart > blockEnd` semantics still
 * holding (`blockEnd` equals `markerLine`).
 */
export function detectProvenanceBlocks(lines: ReadonlyArray<string>): ProvenanceBlock[] {
	const out: ProvenanceBlock[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = MARKER_RE.exec(lines[i]);
		if (!m) { continue; }
		const markerLine = i + 1;
		const modelId = m[1];
		const timestamp = m[2];
		let end = i;
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim() === '') { break; }
			if (MARKER_RE.test(lines[j])) { break; }
			end = j;
		}
		out.push({
			markerLine,
			blockStart: Math.min(markerLine + 1, end + 1),
			blockEnd: end + 1,
			modelId,
			timestamp,
		});
	}
	return out;
}

/**
 * Human-readable hover body for a single block. Markdown — the editor
 * contribution wraps it in `MarkdownString`.
 */
export function renderProvenanceHover(block: ProvenanceBlock): string {
	return [
		`**AI-generated block**`,
		``,
		`- Модель: \`${block.modelId}\``,
		`- Сгенерировано: \`${block.timestamp}\``,
		`- Строки: ${block.markerLine}–${block.blockEnd}`,
	].join('\n');
}
