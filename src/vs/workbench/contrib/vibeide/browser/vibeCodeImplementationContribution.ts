/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { LocationLink } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { symbolLanguageIds } from '../common/codeSymbols/treeSitterSymbols.js';
import { enclosingContainerOf } from '../common/codeSymbols/codeIndexCore.js';
import { IVibeCodeIndexService } from './vibeCodeIndexService.js';
import { rangeOf } from './vibeCodeSymbolPresentation.js';

/**
 * «Перейти к реализациям» (⌘F12): from a class or an interface to whoever inherits it.
 *
 * Until now navigation only went UP — from a use to its declaration. Standing on an interface and
 * asking «who implements this» is just as common when reading someone else's code, and the
 * inheritance map added for `$this->` already holds the answer.
 *
 * Resolved by NAME, like everything here: two unrelated classes called `Base` are one type to this
 * layer. The alternative — guessing which is meant — would be worse than listing both.
 */
class VibeCodeImplementationContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeCodeImplementation';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IVibeCodeIndexService private readonly _index: IVibeCodeIndexService,
	) {
		super();
		const store = this._register(new DisposableStore());
		for (const languageId of symbolLanguageIds()) {
			store.add(languageFeaturesService.implementationProvider.register({ language: languageId }, {
				provideImplementation: (model, position, token) => this._provide(model, languageId, position, token),
			}));
		}
	}

	private async _provide(model: ITextModel, languageId: string, position: IPosition, token: CancellationToken): Promise<LocationLink[] | undefined> {
		if (!this._index.isEnabled(languageId)) {
			return undefined;
		}
		const typeName = await this._typeAt(model, position);
		if (!typeName) {
			return undefined;
		}
		const found = await this._index.descendants(languageId, typeName, token);
		if (token.isCancellationRequested || found.length === 0) {
			return undefined;
		}
		return found.map(({ symbol, file }): LocationLink => ({
			uri: URI.parse(file),
			range: rangeOf(symbol),
		}));
	}

	/**
	 * The type the question is about: the word under the cursor when it names one, otherwise the
	 * type the cursor is standing inside.
	 *
	 * The second case is what makes ⌘F12 useful on a method: standing anywhere in `class Base`, the
	 * question «who inherits this» still has an obvious subject.
	 */
	private async _typeAt(model: ITextModel, position: IPosition): Promise<string | undefined> {
		const word = model.getWordAtPosition(position);
		const { symbols } = await this._index.parseModel(model);
		const named = word?.word;
		if (named && symbols.some(symbol => symbol.name === named && isType(symbol.kind))) {
			return named;
		}
		return enclosingContainerOf(symbols, position.lineNumber - 1)?.at(-1);
	}
}

function isType(kind: string): boolean {
	return kind === 'class' || kind === 'interface' || kind === 'trait' || kind === 'enum';
}

registerWorkbenchContribution2(VibeCodeImplementationContribution.ID, VibeCodeImplementationContribution, WorkbenchPhase.AfterRestored);
