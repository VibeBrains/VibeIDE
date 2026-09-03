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
	/** Child node types the name hides inside (`type_spec`, `variable_declarator`, …). */
	readonly nameInChild?: readonly string[];
	/** Kind used instead of `kind` when the declaration sits inside a container. */
	readonly kindInContainer?: CodeSymbolKind;
	/** Field naming the owner this declaration belongs to (Go's method receiver). */
	readonly ownerField?: string;
	/** Opens a container but is not itself a declaration (Rust's `impl` block). */
	readonly containerOnly?: boolean;
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

/**
 * The other languages: same machinery, different node names.
 *
 * Each table was read off the shipped grammar with a probe, not written from memory — the node names
 * differ more than one would guess (Go hides the type name in a `type_spec`, Java and C# hide a field
 * name in a `variable_declarator`, Rust's `impl` block has no `name` field at all but a `type` one).
 */
const PYTHON_RULES: ReadonlyMap<string, DeclarationRule> = new Map([
	['class_definition', { kind: 'class', nameField: 'name', opensScope: true }],
	// A `def` is a function at file level and a method inside a class — the grammar spells both the same.
	['function_definition', { kind: 'function', nameField: 'name', kindInContainer: 'method' }],
]);

const GO_RULES: ReadonlyMap<string, DeclarationRule> = new Map([
	['type_declaration', { kind: 'class', nameField: 'name', nameInChild: ['type_spec'], opensScope: true }],
	// `func (i *Invoice) Pay()` — the owner is the receiver, not the nesting.
	['method_declaration', { kind: 'method', nameField: 'name', ownerField: 'receiver' }],
	['function_declaration', { kind: 'function', nameField: 'name' }],
	['const_declaration', { kind: 'constant', nameInChild: ['const_spec'] }],
]);

const RUBY_RULES: ReadonlyMap<string, DeclarationRule> = new Map([
	['module', { kind: 'namespace', nameField: 'name', opensScope: true }],
	['class', { kind: 'class', nameField: 'name', opensScope: true }],
	// `def` at file level is a plain function; the same node inside a class is a method.
	['method', { kind: 'function', nameField: 'name', kindInContainer: 'method' }],
	['singleton_method', { kind: 'method', nameField: 'name' }],
]);

const RUST_RULES: ReadonlyMap<string, DeclarationRule> = new Map([
	['mod_item', { kind: 'namespace', nameField: 'name', opensScope: true }],
	['struct_item', { kind: 'class', nameField: 'name', opensScope: true }],
	['enum_item', { kind: 'enum', nameField: 'name', opensScope: true }],
	['trait_item', { kind: 'interface', nameField: 'name', opensScope: true }],
	// `impl Invoice { … }` is not a declaration of `Invoice` — the struct is declared elsewhere. It
	// only opens the scope its functions belong to, so it must not appear in the outline itself.
	['impl_item', { kind: 'class', nameField: 'type', opensScope: true, containerOnly: true }],
	['function_item', { kind: 'function', nameField: 'name', kindInContainer: 'method' }],
	['function_signature_item', { kind: 'method', nameField: 'name' }],
	['const_item', { kind: 'constant', nameField: 'name' }],
]);

const JAVA_RULES: ReadonlyMap<string, DeclarationRule> = new Map([
	['class_declaration', { kind: 'class', nameField: 'name', opensScope: true }],
	['interface_declaration', { kind: 'interface', nameField: 'name', opensScope: true }],
	['enum_declaration', { kind: 'enum', nameField: 'name', opensScope: true }],
	['record_declaration', { kind: 'class', nameField: 'name', opensScope: true }],
	['method_declaration', { kind: 'method', nameField: 'name' }],
	['constructor_declaration', { kind: 'method', nameField: 'name' }],
	['field_declaration', { kind: 'property', nameField: 'name', nameInChild: ['variable_declarator'] }],
]);

const CSHARP_RULES: ReadonlyMap<string, DeclarationRule> = new Map([
	['namespace_declaration', { kind: 'namespace', nameField: 'name', opensScope: true }],
	['file_scoped_namespace_declaration', { kind: 'namespace', nameField: 'name', opensScope: true }],
	['class_declaration', { kind: 'class', nameField: 'name', opensScope: true }],
	['struct_declaration', { kind: 'class', nameField: 'name', opensScope: true }],
	['record_declaration', { kind: 'class', nameField: 'name', opensScope: true }],
	['interface_declaration', { kind: 'interface', nameField: 'name', opensScope: true }],
	['enum_declaration', { kind: 'enum', nameField: 'name', opensScope: true }],
	['method_declaration', { kind: 'method', nameField: 'name' }],
	['constructor_declaration', { kind: 'method', nameField: 'name' }],
	['property_declaration', { kind: 'property', nameField: 'name' }],
	// The name sits two levels down: field_declaration → variable_declaration → variable_declarator.
	['field_declaration', { kind: 'property', nameField: 'name', nameInChild: ['variable_declaration', 'variable_declarator'] }],
]);

/**
 * How a language writes a qualified name. Separate from the rules because it is the half a user sees:
 * `App\Invoice::pay` in PHP is `app.Invoice.Pay` in Go and `Invoice::pay` in Rust, and showing the
 * wrong punctuation makes a correct answer look like someone else's language.
 */
interface LanguageProfile {
	readonly rules: ReadonlyMap<string, DeclarationRule>;
	/** Between containers: `App` + `Invoice`. */
	readonly scopeSeparator: string;
	/** Between the owner and a member declared in it. */
	readonly memberSeparator: string;
	/** Does a bare `namespace X;` apply to its siblings rather than its children? */
	readonly bareNamespaceCoversSiblings?: boolean;
	/** Grammar file name when it differs from the language id (`csharp` → `tree-sitter-c-sharp`). */
	readonly grammar?: string;
	/** Extensions the project index scans for this language. */
	readonly extensions: readonly string[];
	/**
	 * Operators that mean «member of», longest first.
	 *
	 * Language-specific on purpose: `.` accesses a member in Go and Java, but concatenates strings in
	 * PHP, where reading it as access would resolve `$a . helper()` against a phantom owner.
	 */
	readonly memberAccess: readonly string[];
}

const PROFILES: ReadonlyMap<string, LanguageProfile> = new Map<string, LanguageProfile>([
	['php', { rules: PHP_RULES, scopeSeparator: '\\', memberSeparator: '::', bareNamespaceCoversSiblings: true, extensions: ['.php'], memberAccess: ['::', '->'] }],
	['python', { rules: PYTHON_RULES, scopeSeparator: '.', memberSeparator: '.', extensions: ['.py', '.pyi'], memberAccess: ['.'] }],
	['go', { rules: GO_RULES, scopeSeparator: '.', memberSeparator: '.', extensions: ['.go'], memberAccess: ['.'] }],
	['ruby', { rules: RUBY_RULES, scopeSeparator: '::', memberSeparator: '#', extensions: ['.rb', '.rake'], memberAccess: ['::', '.'] }],
	['rust', { rules: RUST_RULES, scopeSeparator: '::', memberSeparator: '::', extensions: ['.rs'], memberAccess: ['::', '.'] }],
	['java', { rules: JAVA_RULES, scopeSeparator: '.', memberSeparator: '.', extensions: ['.java'], memberAccess: ['.'] }],
	// The editor calls the language `csharp`; the grammar file is named `c-sharp`.
	['csharp', { rules: CSHARP_RULES, scopeSeparator: '.', memberSeparator: '.', grammar: 'c-sharp', extensions: ['.cs'], memberAccess: ['.'] }],
]);

/** Languages this module can read declarations of. Used to register providers and nothing else. */
export function symbolLanguageIds(): readonly string[] {
	return [...PROFILES.keys()];
}

/** Name of the grammar file to load for a language — not always the language id. */
export function grammarNameOf(languageId: string): string {
	return PROFILES.get(languageId)?.grammar ?? languageId;
}

/**
 * The container path written as the language writes it: `App\\Billing`, `app.billing`, `App::Billing`.
 *
 * Shown next to a name in the symbol picker, so it is read by a person — borrowing another
 * language's punctuation makes a correct answer look like someone else's project.
 */
export function containerLabel(container: readonly string[], languageId: string): string {
	return container.join(PROFILES.get(languageId)?.scopeSeparator ?? '.');
}

/** Operators meaning «member of» in this language, longest first. */
export function memberAccessOperators(languageId: string): readonly string[] {
	return PROFILES.get(languageId)?.memberAccess ?? [];
}

/** File extensions worth indexing for a language, lower-case and dotted. */
export function extensionsOf(languageId: string): readonly string[] {
	return PROFILES.get(languageId)?.extensions ?? [];
}

/** Is there a declaration table for this language? Asked before loading a grammar for nothing. */
export function supportsSymbolExtraction(languageId: string): boolean {
	return PROFILES.has(languageId);
}

function firstDescendantOfTypes(node: SyntaxNodeLike, types: readonly string[]): SyntaxNodeLike | undefined {
	if (types.length === 0) {
		return node;
	}
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child?.type === types[0]) {
			return firstDescendantOfTypes(child, types.slice(1));
		}
	}
	return undefined;
}

function nameOf(node: SyntaxNodeLike, rule: DeclarationRule): string | undefined {
	// The name may hide one or two levels down: Go puts a type name in a `type_spec`, Java a field
	// name in a `variable_declarator`, C# one level deeper still.
	const host = rule.nameInChild ? firstDescendantOfTypes(node, rule.nameInChild) : node;
	if (!host) {
		return undefined;
	}
	if (rule.nameField) {
		const named = host.childForFieldName(rule.nameField);
		if (named?.text) { return named.text; }
	}
	// Declarations whose name hides one level down (`property_element`, `const_element`) — and the
	// fallback for any rule without a name field.
	for (let i = 0; i < host.namedChildCount; i++) {
		const child = host.namedChild(i);
		if (!child) { continue; }
		if (child.type === 'name' || child.type === 'variable_name' || child.type === 'identifier') { return child.text; }
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
 * The type a Go method is declared on: `func (i *Invoice) Pay()` belongs to `Invoice`.
 *
 * Read from the receiver rather than from nesting, because Go has no nesting here — the method sits
 * at file level and would otherwise land in the index with no owner, making `invoice.Pay()` rank the
 * same as every other `Pay` in the project.
 */
function ownerFromField(node: SyntaxNodeLike, field: string): string | undefined {
	const receiver = node.childForFieldName(field);
	if (!receiver) {
		return undefined;
	}
	let found: string | undefined;
	const dig = (n: SyntaxNodeLike): void => {
		if (found) { return; }
		if (n.type === 'type_identifier') { found = n.text; return; }
		for (let i = 0; i < n.namedChildCount; i++) {
			const child = n.namedChild(i);
			if (child) { dig(child); }
		}
	};
	dig(receiver);
	return found;
}

/**
 * Walk the tree and collect every declaration, innermost containers tracked as we descend.
 *
 * Order is document order, not alphabetical: this feeds an outline, and an outline that reorders
 * the file stops being a map of it.
 */
export function extractSymbols(root: SyntaxNodeLike | null | undefined, languageId: string): CodeSymbol[] {
	const profile = PROFILES.get(languageId);
	if (!root || !profile) {
		return [];
	}
	const rules = profile.rules;
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
				const owner = rule.ownerField ? ownerFromField(node, rule.ownerField) : undefined;
				const declaredIn = owner ? [...effective, owner] : effective;
				if (!rule.containerOnly) {
					out.push({
						name,
						// A `def`/`fn` is a function alone and a method inside a type — same node either way.
						kind: (rule.kindInContainer && declaredIn.length > 0) ? rule.kindInContainer : rule.kind,
						container: rule.kind === 'namespace' ? [] : declaredIn,
						startLine: node.startPosition.row,
						startColumn: node.startPosition.column,
						endLine: node.endPosition.row,
						endColumn: node.endPosition.column,
					});
				}
				if (rule.kind === 'namespace' && profile.bareNamespaceCoversSiblings && !node.childForFieldName('body')) {
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
export function qualifiedName(symbol: CodeSymbol, languageId: string): string {
	if (symbol.container.length === 0) {
		return symbol.name;
	}
	// An unknown language keeps the dot: neutral punctuation is better than another language's.
	const profile = PROFILES.get(languageId);
	const scope = profile?.scopeSeparator ?? '.';
	const isMember = symbol.kind === 'method' || symbol.kind === 'property' || symbol.kind === 'constant';
	const owner = symbol.container.join(scope);
	return `${owner}${isMember ? (profile?.memberSeparator ?? scope) : scope}${symbol.name}`;
}

/** A span of text that is not code: a comment or a string literal. Zero-based, like tree-sitter. */
export interface TextSpan {
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
}

/**
 * Is this node a comment or a string literal?
 *
 * Matched by SUBSTRING, not by prefix, and that is the whole trick: the word is not always at the
 * front. PHP calls its strings `encapsed_string` and Go calls them `interpreted_string_literal`, so
 * an anchored pattern silently failed on exactly the two languages this was written for — caught by
 * a test, not by reading.
 *
 * Known limit: a string with interpolation (`"{$invoice->total}"` in PHP) is treated as non-code in
 * full, so a name used inside one is not counted as an occurrence. Rare enough to accept, and the
 * failure is a missing highlight rather than a wrong jump.
 */
function isNonCodeNode(type: string): boolean {
	return /comment|string|heredoc|char_literal/.test(type);
}

/**
 * Comments and string literals of a file.
 *
 * Used to keep a name mentioned in a docblock or inside a quoted string out of «occurrences» and
 * «references»: it is a mention, not a use, and a list a person has to filter by eye is worth less
 * than a shorter honest one.
 */
export function nonCodeSpans(root: SyntaxNodeLike | null | undefined): TextSpan[] {
	const out: TextSpan[] = [];
	if (!root) {
		return out;
	}
	const walk = (node: SyntaxNodeLike): void => {
		if (isNonCodeNode(node.type)) {
			// The whole span is taken, children included: nothing inside a comment is code.
			out.push({
				startLine: node.startPosition.row,
				startColumn: node.startPosition.column,
				endLine: node.endPosition.row,
				endColumn: node.endPosition.column,
			});
			return;
		}
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (child) { walk(child); }
		}
	};
	walk(root);
	return out;
}

/** Does a zero-based position fall inside any of the spans? */
export function isInsideSpans(spans: readonly TextSpan[], line: number, column: number): boolean {
	return spans.some(span => {
		if (line < span.startLine || line > span.endLine) {
			return false;
		}
		if (line === span.startLine && column < span.startColumn) {
			return false;
		}
		if (line === span.endLine && column >= span.endColumn) {
			return false;
		}
		return true;
	});
}
