/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Declarations of a source file, read from a tree-sitter syntax tree — pure core, no I/O.
 *
 * WHY tree-sitter and not a language server: the usual PHP servers need PHP itself on the machine,
 * and the popular one (Phpactor) additionally needs the `posix` extension, which does not exist in
 * any Windows build of PHP. The grammars here are WebAssembly — they run inside our own process on
 * Windows, macOS and Linux alike, and need no PHP installed at all. The .wasm files already ship
 * with the editor (`@vscode/tree-sitter-wasm`), so this costs no new dependency.
 *
 * WHAT this is NOT: a type checker. It reports what a file DECLARES, by shape of the syntax tree.
 * Two classes with a method of the same name are two separate declarations here, and nothing
 * resolves which one a call refers to — that distinction belongs to the navigation layer above,
 * and is stated plainly there rather than implied by silence here.
 */

/** The subset of the tree-sitter node API this module reads. Kept narrow so tests need no wasm. */
export interface SyntaxNodeLike {
	readonly type: string;
	readonly text: string;
	readonly startPosition: { readonly row: number; readonly column: number };
	readonly endPosition: { readonly row: number; readonly column: number };
	readonly namedChildCount: number;
	namedChild(index: number): SyntaxNodeLike | null;
	childForFieldName(field: string): SyntaxNodeLike | null;
}

/** Mirrors the useful part of `SymbolKind` without importing the editor into `common`. */
export type CodeSymbolKind = 'namespace' | 'class' | 'interface' | 'trait' | 'enum' | 'method' | 'function' | 'property' | 'constant' | 'variable';

export interface CodeSymbol {
	readonly name: string;
	readonly kind: CodeSymbolKind;
	/** Container path, outermost first: `["App\\Billing", "Invoice"]`. Empty at file level. */
	readonly container: readonly string[];
	/** Zero-based, like tree-sitter itself. The editor layer converts to its own 1-based lines. */
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
}

/** Which node types declare something, and how to read the name out of them. */
interface DeclarationRule {
	readonly kind: CodeSymbolKind;
	/** Field holding the name node. `undefined` → look for the first `name`-ish child. */
	readonly nameField?: string;
	/** Does this declaration open a container others nest into (class, namespace)? */
	readonly opensScope?: boolean;
}

/**
 * PHP declaration shapes, verified against the shipped grammar rather than written from memory.
 *
 * `property_declaration` and `const_declaration` do not carry a `name` field — the name sits inside
 * a nested `property_element` / `const_element`, which is why they are read by descent below.
 */
const PHP_RULES: ReadonlyMap<string, DeclarationRule> = new Map([
	['namespace_definition', { kind: 'namespace', nameField: 'name', opensScope: true }],
	['class_declaration', { kind: 'class', nameField: 'name', opensScope: true }],
	['interface_declaration', { kind: 'interface', nameField: 'name', opensScope: true }],
	['trait_declaration', { kind: 'trait', nameField: 'name', opensScope: true }],
	['enum_declaration', { kind: 'enum', nameField: 'name', opensScope: true }],
	['method_declaration', { kind: 'method', nameField: 'name' }],
	['function_definition', { kind: 'function', nameField: 'name' }],
	['property_declaration', { kind: 'property' }],
	['const_declaration', { kind: 'constant' }],
]);

const RULES_BY_LANGUAGE: ReadonlyMap<string, ReadonlyMap<string, DeclarationRule>> = new Map([
	['php', PHP_RULES],
]);

/** Is there a declaration table for this language? Asked before loading a grammar for nothing. */
export function supportsSymbolExtraction(languageId: string): boolean {
	return RULES_BY_LANGUAGE.has(languageId);
}

function nameOf(node: SyntaxNodeLike, rule: DeclarationRule): string | undefined {
	if (rule.nameField) {
		const named = node.childForFieldName(rule.nameField);
		if (named?.text) { return named.text; }
	}
	// Declarations whose name hides one level down (`property_element`, `const_element`) — and the
	// fallback for any rule without a name field.
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (!child) { continue; }
		if (child.type === 'name' || child.type === 'variable_name') { return child.text; }
		if (child.type.endsWith('_element')) {
			for (let j = 0; j < child.namedChildCount; j++) {
				const inner = child.namedChild(j);
				if (inner && (inner.type === 'name' || inner.type === 'variable_name')) { return inner.text; }
			}
		}
	}
	return undefined;
}

/**
 * Walk the tree and collect every declaration, innermost containers tracked as we descend.
 *
 * Order is document order, not alphabetical: this feeds an outline, and an outline that reorders
 * the file stops being a map of it.
 */
export function extractSymbols(root: SyntaxNodeLike | null | undefined, languageId: string): CodeSymbol[] {
	const rules = RULES_BY_LANGUAGE.get(languageId);
	if (!root || !rules) {
		return [];
	}
	const out: CodeSymbol[] = [];

	/**
	 * A `namespace X;` without braces is NOT the parent of what follows it — in the syntax tree the
	 * classes are its SIBLINGS, while in PHP semantics they belong to it until the end of the file
	 * (or the next `namespace`). Verified against the shipped grammar: the braced form carries a
	 * `body` child, the bare form carries only the name.
	 *
	 * So the walk carries a "namespace in effect" that survives past the declaration node, on top of
	 * the ordinary nesting. Without it every class in a real PHP project loses its namespace, and a
	 * jump to `App\Billing\Invoice` finds nothing.
	 */
	const walk = (node: SyntaxNodeLike, container: readonly string[], siblingPrefix: readonly string[]): readonly string[] => {
		const rule = rules.get(node.type);
		const effective = [...siblingPrefix, ...container];
		let nextContainer = container;
		let nextSiblingPrefix = siblingPrefix;
		if (rule) {
			const name = nameOf(node, rule);
			if (name) {
				out.push({
					name,
					kind: rule.kind,
					container: rule.kind === 'namespace' ? [] : effective,
					startLine: node.startPosition.row,
					startColumn: node.startPosition.column,
					endLine: node.endPosition.row,
					endColumn: node.endPosition.column,
				});
				if (rule.kind === 'namespace' && !node.childForFieldName('body')) {
					// Bare `namespace X;` — applies to everything after it, not to children.
					nextSiblingPrefix = [name];
				} else if (rule.opensScope) {
					nextContainer = [...container, name];
				}
			}
		}
		let prefix = nextSiblingPrefix;
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (child) { prefix = walk(child, nextContainer, prefix); }
		}
		return nextSiblingPrefix === siblingPrefix ? prefix : nextSiblingPrefix;
	};
	walk(root, [], []);
	return out;
}

/**
 * Fully qualified name as PHP itself writes it: `App\Billing\Invoice::addLine`.
 *
 * Built from the container path rather than from the source text, so a method declared inside a
 * namespaced class is findable by the same string a caller would write.
 */
export function qualifiedName(symbol: CodeSymbol): string {
	if (symbol.container.length === 0) {
		return symbol.name;
	}
	const isMember = symbol.kind === 'method' || symbol.kind === 'property' || symbol.kind === 'constant';
	const owner = symbol.container.join('\\');
	return isMember ? `${owner}::${symbol.name}` : `${owner}\\${symbol.name}`;
}
