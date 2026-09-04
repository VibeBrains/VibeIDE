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
 *
 * Names are stored under a key the caller supplies, which is how a case-insensitive language (PHP)
 * gets `ProcessInputData` and `processInputData` into the same bucket without this module knowing
 * anything about languages.
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
export function replaceFileSymbols(index: SymbolIndex, file: string, symbols: readonly CodeSymbol[], keyOf: (name: string) => string = name => name): void {
	for (const previous of index.byFile.get(file) ?? []) {
		const list = index.byName.get(keyOf(previous.name));
		if (!list) {
			continue;
		}
		const kept = list.filter(entry => entry.file !== file);
		if (kept.length > 0) { index.byName.set(keyOf(previous.name), kept); } else { index.byName.delete(keyOf(previous.name)); }
	}
	if (symbols.length === 0) {
		index.byFile.delete(file);
		return;
	}
	index.byFile.set(file, [...symbols]);
	for (const symbol of symbols) {
		const key = keyOf(symbol.name);
		const list = index.byName.get(key);
		const entry: IndexedSymbol = { symbol, file };
		if (list) { list.push(entry); } else { index.byName.set(key, [entry]); }
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

/**
 * Rows for the symbol picker: names matching the filter, with open buffers winning over the disk.
 *
 * The limit is the point of this function. The picker opens with an EMPTY query and re-scores
 * everything it is handed on every keystroke, so answering «no filter» with the whole project is
 * how a working feature turns into a stuttering one on a real repository.
 */
export function collectMatches(
	byName: ReadonlyMap<string, IndexedSymbol[]>,
	openByName: ReadonlyMap<string, IndexedSymbol[]>,
	needle: string,
	limit: number,
): IndexedSymbol[] {
	const filter = needle.trim().toLowerCase();
	const matches = (name: string) => !filter || name.toLowerCase().includes(filter);
	const out: IndexedSymbol[] = [];

	for (const [name, entries] of byName) {
		if (out.length >= limit) {
			return out.slice(0, limit);
		}
		if (matches(name)) {
			out.push(...preferOpenBuffers(entries, openByName.get(name) ?? []));
		}
	}
	// Names that exist only in an open buffer — a declaration written but never yet saved.
	for (const [name, entries] of openByName) {
		if (out.length >= limit) {
			break;
		}
		if (matches(name) && !byName.has(name)) {
			out.push(...entries);
		}
	}
	return out.slice(0, limit);
}

/** Declaration kinds that can contain members — the things `$this` and `self` can refer to. */
const CONTAINER_KINDS: ReadonlySet<CodeSymbol['kind']> = new Set<CodeSymbol['kind']>(['class', 'interface', 'trait', 'enum']);

/**
 * The type declaration a line sits inside, innermost first — the meaning of `$this` at that line.
 *
 * Pure, so both «go to definition» and completion answer it the same way; they used to each have
 * their own copy, which is how two features start disagreeing about the same file.
 *
 * @param line zero-based, as tree-sitter counts.
 */
export function enclosingContainerOf(symbols: readonly CodeSymbol[], line: number): readonly string[] | undefined {
	let best: CodeSymbol | undefined;
	for (const symbol of symbols) {
		if (!CONTAINER_KINDS.has(symbol.kind) || symbol.startLine > line || line > symbol.endLine) {
			continue;
		}
		// Innermost wins: a nested class is a better answer than the file's outer one.
		if (!best || symbol.startLine >= best.startLine) {
			best = symbol;
		}
	}
	return best ? [...best.container, best.name] : undefined;
}
