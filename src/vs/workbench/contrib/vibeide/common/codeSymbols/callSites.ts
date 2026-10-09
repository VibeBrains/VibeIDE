/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Calls, imports and declared names of a source file, read from a tree-sitter syntax tree — pure core, no I/O
 *
 * Feeds the project graph its `calls` links: who invokes what, across files
 * This reads the SHAPE of the code, not its types: `o.save()` is a call of something named `save` on something named `o`,
 * And which `save` that is gets decided later, by imports where the language has them and by the name where it does not —
 * With the provenance saying which of the two it was
 */

import { extractSymbols, SyntaxNodeLike } from './treeSitterSymbols.js';

export interface CallSite {
	/** The name being invoked, without receiver or generics: `save` of `repo.save()`, `Foo` of `new Foo<T>()` */
	readonly callee: string;
	/** What it is invoked on, when that is a plain name: `repo` of `repo.save()`; absent for `this.x()` or `a().b()` */
	readonly receiver?: string;
}

export interface ImportBinding {
	/** The name the file uses */
	readonly local: string;
	/** The name exported by the target: `default` for a default import, `*` for a namespace */
	readonly imported: string;
	/** Module specifier exactly as written: `./repo.js` */
	readonly specifier: string;
}

export interface FileCalls {
	readonly calls: readonly CallSite[];
	/** Import bindings, for languages whose imports name a file (TypeScript, JavaScript); empty elsewhere */
	readonly imports: readonly ImportBinding[];
	/** Names this file declares: what a call elsewhere can resolve to */
	readonly declared: readonly string[];
}

/** How a grammar writes a call: the node type, and where in it the callee sits */
interface CallRule {
	/** Field holding the callee expression, or `undefined` to take the first named child */
	readonly calleeField?: string;
	/** For a node that names the callee directly (`member_call_expression`): its name field and receiver field */
	readonly nameField?: string;
	readonly receiverField?: string;
}

/** A callee expression of the form «receiver . name»: node type → its name and receiver fields */
type MemberShapes = ReadonlyMap<string, { readonly name: string; readonly receiver: string }>;

interface CallProfile {
	readonly grammar: string;
	readonly calls: ReadonlyMap<string, CallRule>;
	readonly members: MemberShapes;
	/** Languages whose declarations `extractSymbols` already reads */
	readonly declarationsBySymbols: boolean;
}

const JS_CALLS: ReadonlyMap<string, CallRule> = new Map([
	['call_expression', { calleeField: 'function' }],
	['new_expression', { calleeField: 'constructor' }],
]);
const JS_MEMBERS: MemberShapes = new Map([['member_expression', { name: 'property', receiver: 'object' }]]);

const PROFILES: ReadonlyMap<string, CallProfile> = new Map<string, CallProfile>([
	['typescript', { grammar: 'typescript', calls: JS_CALLS, members: JS_MEMBERS, declarationsBySymbols: false }],
	['typescriptreact', { grammar: 'tsx', calls: JS_CALLS, members: JS_MEMBERS, declarationsBySymbols: false }],
	['javascript', { grammar: 'javascript', calls: JS_CALLS, members: JS_MEMBERS, declarationsBySymbols: false }],
	['php', {
		grammar: 'php', declarationsBySymbols: true, members: new Map(), calls: new Map([
			['function_call_expression', { calleeField: 'function' }],
			['member_call_expression', { nameField: 'name', receiverField: 'object' }],
			['nullsafe_member_call_expression', { nameField: 'name', receiverField: 'object' }],
			['scoped_call_expression', { nameField: 'name', receiverField: 'scope' }],
			['object_creation_expression', {}],
		]),
	}],
	['python', {
		grammar: 'python', declarationsBySymbols: true, calls: new Map([['call', { calleeField: 'function' }]]),
		members: new Map([['attribute', { name: 'attribute', receiver: 'object' }]]),
	}],
	['go', {
		grammar: 'go', declarationsBySymbols: true, calls: new Map([['call_expression', { calleeField: 'function' }]]),
		members: new Map([['selector_expression', { name: 'field', receiver: 'operand' }]]),
	}],
	['ruby', {
		grammar: 'ruby', declarationsBySymbols: true, members: new Map(),
		calls: new Map([['call', { nameField: 'method', receiverField: 'receiver' }]]),
	}],
	['rust', {
		grammar: 'rust', declarationsBySymbols: true, calls: new Map([['call_expression', { calleeField: 'function' }]]),
		members: new Map([
			['field_expression', { name: 'field', receiver: 'value' }],
			['scoped_identifier', { name: 'name', receiver: 'path' }],
		]),
	}],
	['java', {
		grammar: 'java', declarationsBySymbols: true, members: new Map(), calls: new Map([
			['method_invocation', { nameField: 'name', receiverField: 'object' }],
			['object_creation_expression', { calleeField: 'type' }],
		]),
	}],
	['csharp', {
		grammar: 'c-sharp', declarationsBySymbols: true, calls: new Map([
			['invocation_expression', { calleeField: 'function' }],
			['object_creation_expression', { calleeField: 'type' }],
		]),
		members: new Map([['member_access_expression', { name: 'name', receiver: 'expression' }]]),
	}],
]);

const EXTENSIONS: ReadonlyMap<string, string> = new Map([
	['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'],
	['.tsx', 'typescriptreact'],
	['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'], ['.jsx', 'javascript'],
	['.php', 'php'], ['.phtml', 'php'], ['.inc', 'php'],
	['.py', 'python'], ['.pyi', 'python'],
	['.go', 'go'],
	['.rb', 'ruby'], ['.rake', 'ruby'],
	['.rs', 'rust'],
	['.java', 'java'],
	['.cs', 'csharp'],
]);

/** Calls in one language resolve only to declarations in the same family: a TypeScript call never lands in a PHP file */
const FAMILY: ReadonlyMap<string, string> = new Map([['typescript', 'js'], ['typescriptreact', 'js'], ['javascript', 'js']]);

/** The language whose calls this file holds, by extension; undefined for a file the call index does not read */
export function callLanguageOf(path: string): string | undefined {
	const dot = path.lastIndexOf('.');
	return dot === -1 ? undefined : EXTENSIONS.get(path.slice(dot).toLowerCase());
}

/** Grammar file name of a call language */
export function callGrammarOf(languageId: string): string | undefined {
	return PROFILES.get(languageId)?.grammar;
}

export function callFamilyOf(languageId: string): string {
	return FAMILY.get(languageId) ?? languageId;
}

/** The bare name at the end of a written name: `App\\Billing\\Invoice` → `Invoice`, `List<String>` → `List` */
function lastName(text: string): string | undefined {
	const withoutGenerics = text.replace(/<[^]*$/, '');
	const parts = withoutGenerics.split(/::|\\|\.|->/);
	const name = parts[parts.length - 1]?.trim();
	return name && /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
}

/** The object itself: a call on it is a call of the class's own member, not of something named `this` */
const SELF_RECEIVERS: ReadonlySet<string> = new Set(['this', 'self', '$this', 'super', 'parent', 'static']);

/**
 * A receiver kept only when it is a plain name of something else
 * A call on the result of another call has no name to resolve by, and a call on the object itself has no receiver at all
 */
function receiverName(node: SyntaxNodeLike | null): string | undefined {
	if (!node || SELF_RECEIVERS.has(node.text)) {
		return undefined;
	}
	return /^[A-Za-z_$][\w$]*$/.test(node.text) ? node.text : undefined;
}

function calleeOf(expression: SyntaxNodeLike, members: MemberShapes): CallSite | undefined {
	const member = members.get(expression.type);
	if (member) {
		const name = expression.childForFieldName(member.name);
		const callee = name ? lastName(name.text) : undefined;
		return callee ? { callee, receiver: receiverName(expression.childForFieldName(member.receiver)) } : undefined;
	}
	const callee = lastName(expression.text);
	return callee ? { callee } : undefined;
}

function callAt(node: SyntaxNodeLike, rule: CallRule, members: MemberShapes): CallSite | undefined {
	if (rule.nameField) {
		const name = node.childForFieldName(rule.nameField);
		const callee = name ? lastName(name.text) : undefined;
		return callee ? { callee, receiver: rule.receiverField ? receiverName(node.childForFieldName(rule.receiverField)) : undefined } : undefined;
	}
	const expression = rule.calleeField ? node.childForFieldName(rule.calleeField) : firstNamedChild(node);
	return expression ? calleeOf(expression, members) : undefined;
}

function firstNamedChild(node: SyntaxNodeLike): SyntaxNodeLike | null {
	return node.namedChildCount > 0 ? node.namedChild(0) : null;
}

function children(node: SyntaxNodeLike): SyntaxNodeLike[] {
	const out: SyntaxNodeLike[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child) {
			out.push(child);
		}
	}
	return out;
}

function unquote(text: string): string {
	return text.replace(/^['"`]|['"`]$/g, '');
}

/** Bindings of one `import … from '…'` statement */
function importBindings(statement: SyntaxNodeLike): ImportBinding[] {
	const source = statement.childForFieldName('source');
	if (!source) {
		return [];
	}
	const specifier = unquote(source.text);
	const out: ImportBinding[] = [];
	for (const clause of children(statement).filter(child => child.type === 'import_clause')) {
		for (const part of children(clause)) {
			if (part.type === 'identifier') {
				out.push({ local: part.text, imported: 'default', specifier });
			} else if (part.type === 'namespace_import') {
				const name = children(part).find(child => child.type === 'identifier');
				if (name) {
					out.push({ local: name.text, imported: '*', specifier });
				}
			} else if (part.type === 'named_imports') {
				for (const specifierNode of children(part).filter(child => child.type === 'import_specifier')) {
					const imported = specifierNode.childForFieldName('name');
					const alias = specifierNode.childForFieldName('alias');
					if (imported) {
						out.push({ local: (alias ?? imported).text, imported: imported.text, specifier });
					}
				}
			}
		}
	}
	return out;
}

/** Declarations a JavaScript-family file offers to callers: functions, classes, methods, and functions held in constants */
const JS_DECLARATIONS: ReadonlySet<string> = new Set([
	'function_declaration', 'generator_function_declaration', 'class_declaration', 'abstract_class_declaration', 'method_definition',
]);
const JS_FUNCTION_VALUES: ReadonlySet<string> = new Set(['arrow_function', 'function_expression', 'function', 'class']);

/**
 * Calls, imports and declared names of a parsed file
 *
 * Unknown languages give an empty result rather than an error: the call index reads every file of the project,
 * And a file it cannot read simply adds no calls
 */
export function extractCalls(root: SyntaxNodeLike | null | undefined, languageId: string): FileCalls {
	const profile = PROFILES.get(languageId);
	if (!root || !profile) {
		return { calls: [], imports: [], declared: [] };
	}
	const calls: CallSite[] = [];
	const imports: ImportBinding[] = [];
	const declared = new Set<string>(profile.declarationsBySymbols ? extractSymbols(root, languageId).map(symbol => symbol.name) : []);

	// Iterative walk: a minified bundle nests deep enough to overflow a recursive one
	const stack: SyntaxNodeLike[] = [root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		const rule = profile.calls.get(node.type);
		if (rule) {
			const call = callAt(node, rule, profile.members);
			if (call) {
				calls.push(call);
			}
		}
		if (!profile.declarationsBySymbols) {
			if (node.type === 'import_statement') {
				imports.push(...importBindings(node));
			} else if (JS_DECLARATIONS.has(node.type)) {
				const name = node.childForFieldName('name');
				if (name) {
					declared.add(name.text);
				}
			} else if (node.type === 'variable_declarator') {
				const name = node.childForFieldName('name');
				const value = node.childForFieldName('value');
				if (name && value && JS_FUNCTION_VALUES.has(value.type) && name.type === 'identifier') {
					declared.add(name.text);
				}
			}
		}
		for (let i = node.namedChildCount - 1; i >= 0; i--) {
			const child = node.namedChild(i);
			if (child) {
				stack.push(child);
			}
		}
	}
	return { calls, imports, declared: [...declared] };
}
