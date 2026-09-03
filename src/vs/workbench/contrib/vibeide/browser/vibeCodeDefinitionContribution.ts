/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Hover, LocationLink } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { CodeSymbol, qualifiedName, symbolLanguageIds } from '../common/codeSymbols/treeSitterSymbols.js';
import { rankDefinitions, RankedCandidate } from '../common/codeSymbols/codeDefinitionResolve.js';
import { IndexedSymbol, IVibeCodeIndexService } from './vibeCodeIndexService.js';

/**
 * «Перейти к определению» and the hover that goes with it, for the languages we read declarations of.
 *
 * Both surfaces answer from the same index (`IVibeCodeIndexService`) and with the same ranking, so
 * the hover cannot promise a declaration the jump would not take you to.
 *
 * WHAT IT IS, said plainly: navigation by NAME. Nothing infers what a variable holds, so a method
 * reached through `$repo->save()` matches every `save` in the project. Ambiguity is handed to the
 * editor as several locations — it shows a list instead of jumping somewhere arbitrary — and the
 * hover says how many candidates there are rather than showing one as if it were the answer.
 */

class VibeCodeDefinitionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeCodeDefinition';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IVibeCodeIndexService private readonly _index: IVibeCodeIndexService,
	) {
		super();
		const store = this._register(new DisposableStore());
		for (const languageId of symbolLanguageIds()) {
			const selector = { language: languageId };
			store.add(languageFeaturesService.definitionProvider.register(selector, {
				provideDefinition: (model, position, token) => this._provideDefinition(model, languageId, position, token),
			}));
			store.add(languageFeaturesService.hoverProvider.register(selector, {
				provideHover: (model, position, token) => this._provideHover(model, languageId, position, token),
			}));
		}
	}

	private async _ranked(model: ITextModel, languageId: string, position: IPosition, token: CancellationToken): Promise<RankedCandidate[]> {
		if (!this._index.isEnabled(languageId)) {
			return [];
		}
		const word = model.getWordAtPosition(position);
		if (!word) {
			return [];
		}
		const found = await this._index.lookup(languageId, word.word.replace(/^\$/, ''), token);
		if (found.length === 0 || token.isCancellationRequested) {
			return [];
		}
		const byName = new Map<string, RankedCandidate[]>();
		byName.set(word.word.replace(/^\$/, ''), found.map(entry => ({ symbol: entry.symbol, file: entry.file, score: 0 })));
		return rankDefinitions({
			word: word.word,
			lineText: model.getLineContent(position.lineNumber),
			wordStartColumn: word.startColumn - 1,
			enclosingContainer: await this._enclosingContainer(model, languageId, position),
			languageId,
		}, byName);
	}

	private async _provideDefinition(model: ITextModel, languageId: string, position: IPosition, token: CancellationToken): Promise<LocationLink[] | undefined> {
		const ranked = await this._ranked(model, languageId, position, token);
		return ranked.map(({ file, symbol }): LocationLink => ({
			uri: URI.parse(file),
			range: rangeOf(symbol),
		}));
	}

	/**
	 * Hover: what the jump would land on, without making the jump.
	 *
	 * It states the count when several declarations share the name — the honest version of what this
	 * index knows. Silently showing the first would look like certainty that does not exist.
	 */
	private async _provideHover(model: ITextModel, languageId: string, position: IPosition, token: CancellationToken): Promise<Hover | undefined> {
		const ranked = await this._ranked(model, languageId, position, token);
		if (ranked.length === 0) {
			return undefined;
		}
		const word = model.getWordAtPosition(position);
		const best = ranked[0].symbol;
		const lines = [`**${kindLabel(best.kind)}** \`${qualifiedName(best, languageId)}\``];
		if (ranked.length > 1) {
			lines.push('', `Ещё ${ranked.length - 1} объявлен${ranked.length - 1 === 1 ? 'ие' : 'ий'} с этим именем — переход покажет список.`);
		}
		return {
			contents: lines.map(value => ({ value, isTrusted: false })),
			range: word ? {
				startLineNumber: position.lineNumber, startColumn: word.startColumn,
				endLineNumber: position.lineNumber, endColumn: word.endColumn,
			} : undefined,
		};
	}

	/**
	 * Which type the cursor sits inside, read from the file being edited.
	 *
	 * Parsed from the editor's own text rather than from the index: the file on disk may differ from
	 * what the user sees, and `$this->` must mean the class as it is written right now.
	 */
	private async _enclosingContainer(model: ITextModel, languageId: string, position: IPosition): Promise<readonly string[] | undefined> {
		try {
			const line = position.lineNumber - 1;
			let best: CodeSymbol | undefined;
			for (const symbol of await this._index.parseText(languageId, model.getValue())) {
				const isType = symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'trait' || symbol.kind === 'enum';
				if (isType && symbol.startLine <= line && line <= symbol.endLine) {
					// Innermost container whose range covers the cursor.
					if (!best || symbol.startLine >= best.startLine) { best = symbol; }
				}
			}
			return best ? [...best.container, best.name] : undefined;
		} catch {
			return undefined;
		}
	}
}

export function rangeOf(symbol: IndexedSymbol['symbol']) {
	return {
		startLineNumber: symbol.startLine + 1,
		startColumn: symbol.startColumn + 1,
		endLineNumber: symbol.endLine + 1,
		endColumn: symbol.endColumn + 1,
	};
}

/** Human word for a declaration kind — shown in the hover, so it is read, not parsed. */
export function kindLabel(kind: CodeSymbol['kind']): string {
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

registerWorkbenchContribution2(VibeCodeDefinitionContribution.ID, VibeCodeDefinitionContribution, WorkbenchPhase.AfterRestored);
