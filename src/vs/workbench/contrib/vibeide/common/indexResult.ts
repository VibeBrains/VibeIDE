/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A repo index answer read back into its parts — pure
 *
 * The index answers with text written for a model («File: /path:12-40», symbols, a preview); a person's picker needs
 * the file and the lines. Commands once took the whole text for a path and opened nothing
 */

export interface IndexResultParts {
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	/** The fragment shown under the file, without the header lines */
	readonly preview: string;
}

const HEADER = /^File: (?<path>.+?):(?<start>\d+)(?:-(?<end>\d+))?$/m;
const PREVIEW = /^Content preview:\n(?<text>[^]*)$/m;

/** The parts of one answer, or undefined for text that is not an index answer (a cached context snippet) */
export function parseIndexResult(text: string): IndexResultParts | undefined {
	const header = HEADER.exec(text);
	if (!header?.groups) {
		return undefined;
	}
	const startLine = Number(header.groups['start']);
	return {
		path: header.groups['path'],
		startLine,
		endLine: header.groups['end'] ? Number(header.groups['end']) : startLine,
		preview: PREVIEW.exec(text)?.groups?.['text'] ?? '',
	};
}
