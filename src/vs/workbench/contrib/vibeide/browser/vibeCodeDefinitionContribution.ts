/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Hover, LocationLink } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { qualifiedName, symbolLanguageIds } from '../common/codeSymbols/treeSitterSymbols.js';
import { enclosingContainerOf } from '../common/codeSymbols/codeIndexCore.js';
import { kindLabel, rangeOf } from './vibeCodeSymbolPresentation.js';
import { rankDefinitions, RankedCandidate } from '../common/codeSymbols/codeDefinitionResolve.js';
import { IVibeCodeIndexService } from './vibeCodeIndexService.js';

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
		return rankDefinitions({
			word: word.word,
			lineText: model.getLineContent(position.lineNumber),
			wordStartColumn: word.startColumn - 1,
			enclosingContainer: await this._enclosingContainer(model, position),
			languageId,
		}, found.map(entry => ({ symbol: entry.symbol, file: entry.file, score: 0 })));
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
		const best = ranked[0];
		const lines = [`**${kindLabel(best.symbol.kind)}** \`${qualifiedName(best.symbol, languageId)}\``];
		// Where it is declared — the hover's job is to answer without making the jump. The file of
		// the current editor is named as «здесь», because repeating its own path tells the reader
		// nothing they cannot see.
		const declaredIn = best.file === model.uri.toString()
			? `здесь, строка ${best.symbol.startLine + 1}`
			: `${basename(URI.parse(best.file))}, строка ${best.symbol.startLine + 1}`;
		lines.push('', declaredIn);
		if (ranked.length > 1) {
			lines.push('', `Ещё ${ranked.length - 1} объявлен${ranked.length - 1 === 1 ? 'ие' : 'ий'} с этим именем — переход покажет список.`);
		}
		return {
			// One markdown value, not one per line: the hover renders each entry as its own block, and
			// an empty entry between them showed as nothing at all rather than as a blank line.
			contents: [{ value: lines.filter(line => line !== '').join('\n\n'), isTrusted: false }],
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
	private async _enclosingContainer(model: ITextModel, position: IPosition): Promise<readonly string[] | undefined> {
		try {
			const { symbols } = await this._index.parseModel(model);
			return enclosingContainerOf(symbols, position.lineNumber - 1);
		} catch {
			return undefined;
		}
	}
}

registerWorkbenchContribution2(VibeCodeDefinitionContribution.ID, VibeCodeDefinitionContribution, WorkbenchPhase.AfterRestored);
