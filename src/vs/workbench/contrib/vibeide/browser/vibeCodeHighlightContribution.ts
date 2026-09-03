/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { DocumentHighlight, DocumentHighlightKind } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { symbolLanguageIds } from '../common/codeSymbols/treeSitterSymbols.js';
import { IVibeCodeIndexService } from './vibeCodeIndexService.js';

/**
 * Occurrence highlighting: put the cursor on a name and every use of it in this file lights up.
 *
 * The editor does this for languages with a server and for nobody else, so for our seven the feature
 * simply did not exist. Written declaration-aware rather than as a plain text match: the place where
 * the name is DECLARED is marked as a write, the rest as reads, which is the distinction the editor's
 * own colours are for.
 *
 * Scope is one file, on purpose — the same honesty as the jump. Without knowing types, «every use in
 * the project» would light up unrelated methods that merely share a name.
 */
/** Word separators for whole-word matching — the editor's own default set. */
const USUAL_WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

class VibeCodeHighlightContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeCodeHighlight';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IVibeCodeIndexService private readonly _index: IVibeCodeIndexService,
	) {
		super();
		const store = this._register(new DisposableStore());
		for (const languageId of symbolLanguageIds()) {
			store.add(languageFeaturesService.documentHighlightProvider.register({ language: languageId }, {
				provideDocumentHighlights: (model, position, token) => this._provide(model, languageId, position, token),
			}));
		}
	}

	private async _provide(model: ITextModel, languageId: string, position: IPosition, token: CancellationToken): Promise<DocumentHighlight[] | undefined> {
		if (!this._index.isEnabled(languageId)) {
			return undefined;
		}
		const word = model.getWordAtPosition(position);
		if (!word) {
			return undefined;
		}
		const name = word.word;
		const declared = await this._index.parseText(languageId, model.getValue());
		if (token.isCancellationRequested) {
			return undefined;
		}
		const declarationLines = new Set(declared.filter(symbol => symbol.name === name).map(symbol => symbol.startLine + 1));

		// Whole-word, case-sensitive: `pay` must not light up inside `payment` or match `Pay`.
		const matches = model.findMatches(name, true, false, true, USUAL_WORD_SEPARATORS, false);
		if (token.isCancellationRequested) {
			return undefined;
		}
		return matches.map(match => ({
			range: match.range,
			// The declaration is a write, every other occurrence a read — that is what the two
			// different highlight colours in the editor mean.
			kind: declarationLines.has(match.range.startLineNumber) ? DocumentHighlightKind.Write : DocumentHighlightKind.Read,
		}));
	}
}

registerWorkbenchContribution2(VibeCodeHighlightContribution.ID, VibeCodeHighlightContribution, WorkbenchPhase.AfterRestored);
