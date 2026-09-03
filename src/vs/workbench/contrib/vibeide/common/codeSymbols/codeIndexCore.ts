/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CodeSymbol } from './treeSitterSymbols.js';

/**
 * The bookkeeping of the declaration index — pure, so it is testable without a workspace.
 *
 * Two rules live here, and both exist because of how the index is used rather than how it is built:
 *
 *  - a changed file replaces ONLY its own declarations. Dropping the whole index on every save would
 *    make the next jump re-read the entire project, which is a cost the user pays for nothing;
 *  - an open editor outranks the disk for the same file, so a method typed a second ago is findable
 *    before it is saved — exactly when it is needed most.
 */

/** A declaration together with the file it lives in. The file is an opaque key (a URI string). */
export interface IndexedSymbol {
	readonly symbol: CodeSymbol;
	readonly file: string;
}

/** name → declarations, plus file → its own declarations so one file can be replaced in place. */
export interface SymbolIndex {
	readonly byName: Map<string, IndexedSymbol[]>;
	readonly byFile: Map<string, CodeSymbol[]>;
}

export function createSymbolIndex(): SymbolIndex {
	return { byName: new Map(), byFile: new Map() };
}

/**
 * Replace everything one file contributes, leaving every other file untouched.
 *
 * An empty `symbols` list removes the file — which is also what a deletion means, so callers need no
 * separate path for it.
 */
export function replaceFileSymbols(index: SymbolIndex, file: string, symbols: readonly CodeSymbol[]): void {
	for (const previous of index.byFile.get(file) ?? []) {
		const list = index.byName.get(previous.name);
		if (!list) {
			continue;
		}
		const kept = list.filter(entry => entry.file !== file);
		if (kept.length > 0) { index.byName.set(previous.name, kept); } else { index.byName.delete(previous.name); }
	}
	if (symbols.length === 0) {
		index.byFile.delete(file);
		return;
	}
	index.byFile.set(file, [...symbols]);
	for (const symbol of symbols) {
		const list = index.byName.get(symbol.name);
		const entry: IndexedSymbol = { symbol, file };
		if (list) { list.push(entry); } else { index.byName.set(symbol.name, [entry]); }
	}
}

/**
 * What the editor shows wins over what the disk holds, for the files that are open.
 *
 * Only the open files are overridden: declarations in every other file keep answering from the
 * index, so having one file open never narrows the search.
 */
export function preferOpenBuffers(fromDisk: readonly IndexedSymbol[], open: readonly IndexedSymbol[]): IndexedSymbol[] {
	if (open.length === 0) {
		return [...fromDisk];
	}
	const overridden = new Set(open.map(entry => entry.file));
	return [...open, ...fromDisk.filter(entry => !overridden.has(entry.file))];
}
