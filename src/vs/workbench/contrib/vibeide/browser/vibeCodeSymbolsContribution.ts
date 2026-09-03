/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { DocumentSymbol, SymbolTag } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { CodeSymbol, symbolLanguageIds } from '../common/codeSymbols/treeSitterSymbols.js';
import { rangeOf, SYMBOL_KIND_MAP } from './vibeCodeSymbolPresentation.js';
import { IVibeCodeIndexService } from './vibeCodeIndexService.js';

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

/** Joins container paths into a lookup key. Not a language separator — no identifier contains it. */
const PATH_KEY_SEPARATOR = '\u0000';

export function toOutline(symbols: readonly CodeSymbol[]): DocumentSymbol[] {
	const roots: DocumentSymbol[] = [];
	const byPath = new Map<string, DocumentSymbol>();

	const asDocumentSymbol = (s: CodeSymbol): DocumentSymbol => {
		const range = rangeOf(s);
		return {
			name: s.name,
			detail: '',
			kind: SYMBOL_KIND_MAP[s.kind],
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
		@IVibeCodeIndexService private readonly _index: IVibeCodeIndexService,
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
		// One setting governs every navigation surface: a language switched off must not keep
		// producing our outline while its jumps come from somewhere else.
		if (!this._index.isEnabled(languageId)) {
			return undefined;
		}
		// Parsed through the index service, which owns one parser per language. Creating a parser here
		// would mean a second WASM parser built and destroyed on every keystroke.
		const symbols = await this._index.parseText(languageId, model.getValue());
		return token.isCancellationRequested ? undefined : toOutline(symbols);
	}
}

registerWorkbenchContribution2(VibeCodeSymbolsContribution.ID, VibeCodeSymbolsContribution, WorkbenchPhase.AfterRestored);
