/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CodeSymbol, CodeSymbolKind } from './treeSitterSymbols.js';

/**
 * «Что имел в виду курсор» — pure decision layer for jumping to a PHP declaration.
 *
 * HONEST SCOPE, stated here because the UI cannot state it: this resolves NAMES, not types. Nothing
 * infers what `$repo` holds, so `$repo->save()` matches every `save` declared anywhere in the
 * project. The answer is therefore a RANKED LIST, not a single truth — the editor shows the list
 * whenever it is longer than one, which is honest, and better than confidently landing in the wrong
 * class.
 *
 * What the surrounding text does buy is ranking, and it buys a lot:
 *   - `Invoice::pay` and `new Invoice` name the owner outright → its members come first;
 *   - `$this->pay()` means the enclosing class → its own members first;
 *   - a call `pay(` is a function or a method, never a property;
 *   - a bare `Invoice` is a type, so classes outrank methods of the same name.
 */

export interface DefinitionQuery {
	/** Identifier under the cursor, without `$`, `::`, `->` or parentheses. */
	readonly word: string;
	/** The whole line, so the shape around the word can be read. */
	readonly lineText: string;
	/** 0-based column where `word` starts — the same line can hold the name twice. */
	readonly wordStartColumn: number;
	/** Container path of the declaration the cursor sits inside, if any. Ranks `$this->…`. */
	readonly enclosingContainer?: readonly string[];
}

export interface RankedCandidate {
	readonly symbol: CodeSymbol;
	/** File the symbol was declared in — an index key, opaque to this module. */
	readonly file: string;
	/** Higher is better. Exposed so the caller can show ties rather than hide them. */
	readonly score: number;
}

/** How the name was written at the call site. Read from the text, never guessed from the name. */
export type CallShape = 'static-member' | 'instance-member' | 'this-member' | 'instantiation' | 'call' | 'plain';

const MEMBER_KINDS: ReadonlySet<CodeSymbolKind> = new Set<CodeSymbolKind>(['method', 'property', 'constant']);
const TYPE_KINDS: ReadonlySet<CodeSymbolKind> = new Set<CodeSymbolKind>(['class', 'interface', 'trait', 'enum']);
const CALLABLE_KINDS: ReadonlySet<CodeSymbolKind> = new Set<CodeSymbolKind>(['method', 'function']);

/** `self`, `static` and `parent` name the enclosing class rather than a type spelled out. */
const RELATIVE_OWNERS: ReadonlySet<string> = new Set(['self', 'static', 'parent']);

/**
 * Read the shape around the identifier, plus the owner when the source names one.
 *
 * The prefix is examined right-to-left from the identifier, so a line holding several calls
 * resolves the one under the cursor rather than the first on the line.
 */
export function readCallShape(lineText: string, wordStartColumn: number): { shape: CallShape; owner?: string } {
	const before = lineText.slice(0, Math.max(0, wordStartColumn));
	const after = lineText.slice(Math.max(0, wordStartColumn));
	const isCall = /^[A-Za-z_][\w]*\s*\(/.test(after);

	const staticOwner = before.match(/([\\\w]+)\s*::\s*$/);
	if (staticOwner) {
		return { shape: 'static-member', owner: staticOwner[1] };
	}
	if (/\$this\s*->\s*$/.test(before)) {
		return { shape: 'this-member' };
	}
	if (/\$[\w]+\s*->\s*$/.test(before)) {
		return { shape: 'instance-member' };
	}
	if (/\bnew\s+$/.test(before)) {
		return { shape: 'instantiation' };
	}
	return { shape: isCall ? 'call' : 'plain' };
}

/** Last segment of a possibly qualified PHP name: `\App\Invoice` → `Invoice`. */
function baseName(name: string): string {
	const parts = name.split('\\');
	return parts[parts.length - 1] || name;
}

/**
 * Rank the declarations that could be what the cursor points at.
 *
 * Returns an empty list rather than a guess when nothing matches by name: a jump that lands
 * somewhere arbitrary is worse than a jump that politely does not happen.
 */
export function rankDefinitions(query: DefinitionQuery, index: ReadonlyMap<string, readonly RankedCandidate[]>): RankedCandidate[] {
	const word = query.word.replace(/^\$/, '');
	if (!word) {
		return [];
	}
	const byName = index.get(word);
	if (!byName || byName.length === 0) {
		return [];
	}
	const { shape, owner } = readCallShape(query.lineText, query.wordStartColumn);
	const ownerBase = owner ? baseName(owner) : undefined;
	const enclosing = query.enclosingContainer ?? [];
	const enclosingOwner = enclosing.length > 0 ? enclosing[enclosing.length - 1] : undefined;

	const scored = byName.map(candidate => {
		const { kind, container } = candidate.symbol;
		const declaredOwner = container.length > 0 ? container[container.length - 1] : undefined;
		let score = 0;

		switch (shape) {
			case 'static-member':
				if (MEMBER_KINDS.has(kind)) { score += 3; }
				if (declaredOwner && ownerBase && (declaredOwner === ownerBase
					|| (RELATIVE_OWNERS.has(ownerBase) && declaredOwner === enclosingOwner))) {
					score += 6;
				}
				break;
			case 'this-member':
				if (MEMBER_KINDS.has(kind)) { score += 3; }
				if (declaredOwner && declaredOwner === enclosingOwner) { score += 6; }
				break;
			case 'instance-member':
				// The variable's type is unknown by construction; members simply outrank types.
				if (MEMBER_KINDS.has(kind)) { score += 3; }
				break;
			case 'instantiation':
				if (TYPE_KINDS.has(kind)) { score += 6; }
				break;
			case 'call':
				if (CALLABLE_KINDS.has(kind)) { score += 3; }
				break;
			case 'plain':
				if (TYPE_KINDS.has(kind)) { score += 2; }
				break;
		}
		// A declaration in the class being edited is likelier than one across the project.
		if (declaredOwner && declaredOwner === enclosingOwner) { score += 1; }
		return { ...candidate, score };
	});

	// Ties keep index order, which is file order — stable between invocations, so the same jump
	// twice lands in the same place.
	return scored.sort((a, b) => b.score - a.score);
}
