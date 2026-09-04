/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CodeSymbol, CodeSymbolKind, memberAccessOperators } from './treeSitterSymbols.js';

/**
 * «Что имел в виду курсор» — pure decision layer for jumping to a declaration, in any of the
 * supported languages.
 *
 * HONEST SCOPE, stated here because the UI cannot state it: this resolves NAMES, not types. Nothing
 * infers what `$repo` holds, so `$repo->save()` matches every `save` declared anywhere in the
 * project. The answer is therefore a RANKED LIST, not a single truth — the editor shows the list
 * whenever it is longer than one, which is honest, and better than confidently landing in the wrong
 * class.
 *
 * What the surrounding text does buy is ranking, and it buys a lot:
 *   - `Invoice::pay`, `Invoice.pay` and `new Invoice` name the owner outright → its members first;
 *   - `$this->pay()`, `this.pay()`, `self.pay()` mean the enclosing class → its own members first;
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
	/**
	 * The owner's own name followed by everything it inherits from, nearest first.
	 *
	 * Without it a method declared in a parent class is not recognised as «mine»: `$this->pay()` in a
	 * subclass would rank the parent's `pay` no higher than a same-named method of an unrelated class.
	 */
	readonly ownerChain?: readonly string[];
	/** Which language's access operators to read. */
	readonly languageId: string;
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

/**
 * Owners that name the enclosing type rather than a type spelled out.
 *
 * One set for every language on purpose: `self` means the same thing in PHP, Python, Rust and Ruby,
 * and a language that does not use a word simply never produces it.
 */
const RELATIVE_OWNERS: ReadonlySet<string> = new Set(['self', '$this', 'this', 'static', 'parent', 'Self', 'super', 'base', 'me']);

/** Escape a literal operator for use inside a regular expression. */
function escapeForRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read the shape around the identifier, plus the owner when the source names one.
 *
 * The prefix is examined right-to-left from the identifier, so a line holding several calls
 * resolves the one under the cursor rather than the first on the line.
 *
 * Which characters count as «member of» comes from the language, not from a fixed list: `.` is
 * member access in Go and Java but string concatenation in PHP, where treating it as access would
 * make `$a . helper()` look like a member of `$a`.
 */
export function readCallShape(lineText: string, wordStartColumn: number, languageId: string): { shape: CallShape; owner?: string } {
	const before = lineText.slice(0, Math.max(0, wordStartColumn));
	const after = lineText.slice(Math.max(0, wordStartColumn));
	const isCall = /^[A-Za-z_][\w]*\s*\(/.test(after);

	const operators = memberAccessOperators(languageId);
	for (const operator of operators) {
		const match = before.match(new RegExp(`([$@]?[\\\\\\w]+)\\s*${escapeForRegExp(operator)}\\s*$`));
		if (!match) {
			continue;
		}
		const owner = match[1];
		if (RELATIVE_OWNERS.has(owner)) {
			return { shape: 'this-member' };
		}
		// A named type is an owner we can rank against; a variable's type is unknowable here, so the
		// owner is deliberately dropped rather than passed on as a guess.
		const base = baseName(owner);
		return /^[A-Z]/.test(base) ? { shape: 'static-member', owner } : { shape: 'instance-member' };
	}
	if (/\bnew\s+$/.test(before)) {
		return { shape: 'instantiation' };
	}
	return { shape: isCall ? 'call' : 'plain' };
}

/** Last segment of a qualified name: `\App\Invoice` → `Invoice`, `app.Invoice` → `Invoice`. */
function baseName(name: string): string {
	const parts = name.split(/[\\.]|::/);
	return parts[parts.length - 1] || name;
}

/**
 * Rank the declarations that could be what the cursor points at.
 *
 * Takes the candidates for that name directly — a list, not a map: the caller already knows which
 * name it looked up, and building a one-key map to hand it over was ceremony.
 *
 * Returns an empty list rather than a guess when nothing matches by name: a jump that lands
 * somewhere arbitrary is worse than a jump that politely does not happen.
 */
export function rankDefinitions(query: DefinitionQuery, candidates: readonly RankedCandidate[]): RankedCandidate[] {
	const word = query.word.replace(/^\$/, '');
	if (!word || candidates.length === 0) {
		return [];
	}
	// Callers pass the declarations of this one name; filtering here keeps the contract honest even
	// if a caller hands over a wider list.
	const byName = candidates.filter(candidate => candidate.symbol.name === word);
	if (byName.length === 0) {
		return [];
	}
	const { shape, owner } = readCallShape(query.lineText, query.wordStartColumn, query.languageId);
	const ownerBase = owner ? baseName(owner) : undefined;
	const enclosing = query.enclosingContainer ?? [];
	const enclosingOwner = enclosing.length > 0 ? enclosing[enclosing.length - 1] : undefined;
	/** Position in the inheritance chain: 0 is the class itself, larger is further up. */
	const chainDepth = (owner: string | undefined): number => {
		if (!owner) { return -1; }
		const index = query.ownerChain?.indexOf(owner) ?? -1;
		return index >= 0 ? index : (owner === enclosingOwner ? 0 : -1);
	};
	const isCallShaped = /^[\w]+\s*\(/.test(query.lineText.slice(Math.max(0, query.wordStartColumn)));

	const scored = byName.map(candidate => {
		const { kind, container } = candidate.symbol;
		const declaredOwner = container.length > 0 ? container[container.length - 1] : undefined;
		let score = 0;

		switch (shape) {
			case 'static-member': {
				if (MEMBER_KINDS.has(kind)) { score += 3; }
				const relative = !!ownerBase && RELATIVE_OWNERS.has(ownerBase);
				if (declaredOwner && ownerBase && declaredOwner === ownerBase) {
					score += 6;
				} else if (relative) {
					// `self::` / `parent::` mean the enclosing class and whatever it inherits.
					const depth = chainDepth(declaredOwner);
					if (depth >= 0) { score += Math.max(1, 6 - depth); }
				}
				break;
			}
			case 'this-member': {
				// The nearest declaration in the inheritance chain wins: a method redeclared in the
				// subclass overrides the parent's, and an inherited one still beats a stranger's.
				if (MEMBER_KINDS.has(kind)) { score += 3; }
				const depth = chainDepth(declaredOwner);
				if (depth >= 0) { score += Math.max(1, 6 - depth); }
				break;
			}
			case 'instance-member':
				// The variable's type is unknown by construction; members simply outrank types.
				if (MEMBER_KINDS.has(kind)) { score += 3; }
				// In Go and Rust the same shape also spells a package or module function
				// (`billing.Charge()`), so a callable declared at file level stays plausible.
				if (isCallShaped && CALLABLE_KINDS.has(kind) && container.length === 0) { score += 3; }
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
		// A declaration in the class being edited — or in one it inherits from — is likelier than one
		// found anywhere across the project.
		if (chainDepth(declaredOwner) >= 0) { score += 1; }
		return { ...candidate, score };
	});

	// Ties keep index order, which is file order — stable between invocations, so the same jump
	// twice lands in the same place.
	return scored.sort((a, b) => b.score - a.score);
}
