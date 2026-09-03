/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { DocumentSymbol, SymbolKind, SymbolTag } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITreeSitterLibraryService } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { CodeSymbol, CodeSymbolKind, extractSymbols, grammarNameOf, symbolLanguageIds, SyntaxNodeLike } from '../common/codeSymbols/treeSitterSymbols.js';
import { vibeLog } from '../common/vibeLog.js';

/**
 * Outline for languages the editor ships no symbol provider for — PHP first.
 *
 * WHY this exists at all: `php-language-features` registers completion, hover and signature help,
 * and nothing else. There is no outline, no «go to symbol in file», and — the part that surprises —
 * no symbols in our own RAG index or code graph either, because `repoIndexerService` collects them
 * *through* `documentSymbolProvider`. One missing provider silently emptied three surfaces.
 *
 * WHY tree-sitter rather than a language server: the usual PHP servers need PHP on the machine, and
 * Phpactor additionally needs the `posix` extension, which no Windows build of PHP has. The grammar
 * here is WebAssembly running inside our own process — identical on Windows, macOS and Linux, with
 * no PHP installed. The `.wasm` already ships with the editor, so this adds no dependency.
 *
 * The grammar is loaded with `ignoreSupportsCheck: true` on purpose: the editor's own
 * `editor.experimental.preferTreeSitter.*` switch governs experimental *highlighting*, and an
 * outline has no business being gated behind an unrelated experiment.
 */

/**
 * Languages come from the declaration tables themselves, so adding a language is one table and no
 * second list to keep in step with it.
 */
const SUPPORTED_LANGUAGES = symbolLanguageIds();

const KIND_MAP: Readonly<Record<CodeSymbolKind, SymbolKind>> = {
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

/**
 * Flat list of declarations → the nested shape the outline draws.
 *
 * Nesting is rebuilt from each symbol's container path rather than from source ranges: a bare
 * `namespace X;` does not span the file it governs, so range containment would put every class
 * outside the namespace it belongs to.
 */
/** Joins container paths into a lookup key. Not a language separator — no identifier contains it. */
const PATH_KEY_SEPARATOR = '\u0000';

export function toOutline(symbols: readonly CodeSymbol[]): DocumentSymbol[] {
	const roots: DocumentSymbol[] = [];
	const byPath = new Map<string, DocumentSymbol>();

	const asDocumentSymbol = (s: CodeSymbol): DocumentSymbol => {
		const range = {
			startLineNumber: s.startLine + 1,
			startColumn: s.startColumn + 1,
			endLineNumber: s.endLine + 1,
			endColumn: s.endColumn + 1,
		};
		return {
			name: s.name,
			detail: '',
			kind: KIND_MAP[s.kind],
			tags: [] as SymbolTag[],
			range,
			// Same range for selection: without a name-only range the editor still reveals the
			// declaration, which is what the user asked for by clicking it.
			selectionRange: range,
			children: [],
		};
	};

	for (const symbol of symbols) {
		const entry = asDocumentSymbol(symbol);
		const parent = symbol.container.length > 0 ? byPath.get(symbol.container.join(PATH_KEY_SEPARATOR)) : undefined;
		if (parent) {
			parent.children!.push(entry);
		} else {
			roots.push(entry);
		}
		const ownPath = [...symbol.container, symbol.name].join(PATH_KEY_SEPARATOR);
		// First declaration of a path wins: a redeclared class is a mistake in the file, and letting
		// the second one capture the children would move half the outline under it.
		if (!byPath.has(ownPath)) {
			byPath.set(ownPath, entry);
		}
	}
	return roots;
}

class VibeCodeSymbolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeCodeSymbols';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ITreeSitterLibraryService private readonly _treeSitter: ITreeSitterLibraryService,
	) {
		super();
		const store = this._register(new DisposableStore());
		for (const languageId of SUPPORTED_LANGUAGES) {
			store.add(languageFeaturesService.documentSymbolProvider.register({ language: languageId }, {
				displayName: 'VibeIDE',
				provideDocumentSymbols: (model, token) => this._provide(model, languageId, token),
			}));
		}
	}

	private async _provide(model: ITextModel, languageId: string, token: CancellationToken): Promise<DocumentSymbol[] | undefined> {
		try {
			const [ParserClass, language] = await Promise.all([
				this._treeSitter.getParserClass(),
				this._treeSitter.getLanguagePromise(grammarNameOf(languageId)),
			]);
			if (!language || token.isCancellationRequested) {
				return undefined;
			}
			const parser = new ParserClass();
			try {
				parser.setLanguage(language);
				const tree = parser.parse(model.getValue());
				if (!tree || token.isCancellationRequested) {
					return undefined;
				}
				try {
					return toOutline(extractSymbols(tree.rootNode as unknown as SyntaxNodeLike, languageId));
				} finally {
					tree.delete();
				}
			} finally {
				// The parser holds WASM memory: an outline recomputed on every keystroke would leak
				// it steadily, and the leak would look like «the editor got slow», not like a bug.
				parser.delete();
			}
		} catch (err) {
			vibeLog.warn('codeSymbols', `структуру файла построить не удалось (${languageId}): ${err}`);
			return undefined;
		}
	}
}

registerWorkbenchContribution2(VibeCodeSymbolsContribution.ID, VibeCodeSymbolsContribution, WorkbenchPhase.AfterRestored);
