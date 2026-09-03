/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRange } from '../../../../editor/common/core/range.js';
import { SymbolKind } from '../../../../editor/common/languages.js';
import { CodeSymbol, CodeSymbolKind } from '../common/codeSymbols/treeSitterSymbols.js';

/**
 * How a declaration is shown: its range, its icon and its name in Russian.
 *
 * Lives on its own because four providers show the same symbols — the outline, the jump, the symbol
 * picker and references. Keeping it in whichever provider happened to need it first made the others
 * import from a neighbour for no reason.
 */

/** Zero-based tree-sitter positions → the editor's own 1-based range. */
export function rangeOf(symbol: CodeSymbol): IRange {
	return {
		startLineNumber: symbol.startLine + 1,
		startColumn: symbol.startColumn + 1,
		endLineNumber: symbol.endLine + 1,
		endColumn: symbol.endColumn + 1,
	};
}

export const SYMBOL_KIND_MAP: Readonly<Record<CodeSymbolKind, SymbolKind>> = {
	namespace: SymbolKind.Namespace,
	class: SymbolKind.Class,
	interface: SymbolKind.Interface,
	// The editor has no «trait»; Class reads better in the outline than Object.
	trait: SymbolKind.Class,
	enum: SymbolKind.Enum,
	method: SymbolKind.Method,
	function: SymbolKind.Function,
	property: SymbolKind.Property,
	constant: SymbolKind.Constant,
	variable: SymbolKind.Variable,
};

/** Human word for a declaration kind — read by a person in a hover, not parsed. */
export function kindLabel(kind: CodeSymbolKind): string {
	switch (kind) {
		case 'namespace': return 'пространство имён';
		case 'class': return 'класс';
		case 'interface': return 'интерфейс';
		case 'trait': return 'трейт';
		case 'enum': return 'перечисление';
		case 'method': return 'метод';
		case 'function': return 'функция';
		case 'property': return 'свойство';
		case 'constant': return 'константа';
		case 'variable': return 'переменная';
	}
}
