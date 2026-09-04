/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { SignatureHelp, SignatureHelpResult } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { containerLabel, symbolLanguageIds } from '../common/codeSymbols/treeSitterSymbols.js';
import { activeCallAt, splitParameters } from '../common/codeSymbols/callSignature.js';
import { IVibeCodeIndexService } from './vibeCodeIndexService.js';

/**
 * Подсказка параметров при наборе вызова (⇧⌘Space, и сама при вводе `(` или `,`).
 *
 * WHY: for a language without a server this does not exist at all — you type `pay(` and the editor
 * has nothing to say about what goes inside. The index already stores the parameter list of every
 * declaration, exactly as its author wrote it.
 *
 * The same honesty as everywhere here: with several declarations of one name we show them all as
 * separate signatures rather than picking one, because nothing here knows the type of the receiver.
 */
class VibeCodeSignatureContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeCodeSignature';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IVibeCodeIndexService private readonly _index: IVibeCodeIndexService,
	) {
		super();
		const store = this._register(new DisposableStore());
		for (const languageId of symbolLanguageIds()) {
			store.add(languageFeaturesService.signatureHelpProvider.register({ language: languageId }, {
				signatureHelpTriggerCharacters: ['(', ','],
				signatureHelpRetriggerCharacters: [')'],
				provideSignatureHelp: (model, position, token, _context) => this._provide(model, languageId, position, token),
			}));
		}
	}

	private async _provide(model: ITextModel, languageId: string, position: IPosition, token: CancellationToken): Promise<SignatureHelpResult | undefined> {
		if (!this._index.isEnabled(languageId)) {
			return undefined;
		}
		const call = activeCallAt(model.getLineContent(position.lineNumber), position.column - 1);
		if (!call) {
			return undefined;
		}
		const found = await this._index.lookup(languageId, call.name, token);
		if (token.isCancellationRequested) {
			return undefined;
		}
		// Only declarations that take parameters can answer this question.
		const withParams = found.filter(entry => entry.symbol.params);
		if (withParams.length === 0) {
			return undefined;
		}

		const help: SignatureHelp = {
			activeSignature: 0,
			activeParameter: call.argumentIndex,
			signatures: withParams.slice(0, MAX_SIGNATURES).map(entry => {
				const owner = entry.symbol.container.length > 0 ? containerLabel(entry.symbol.container, languageId) : undefined;
				return {
					label: `${entry.symbol.name}${entry.symbol.params}`,
					documentation: owner
						? { value: localize('vibeide.codeNavigation.signatureOwner', 'Объявлено в {0}', owner) }
						: undefined,
					parameters: splitParameters(entry.symbol.params!).map(label => ({ label })),
				};
			}),
		};
		return { value: help, dispose: () => { } };
	}
}

/** Several same-named methods are shown as alternatives; past this the list stops being readable. */
const MAX_SIGNATURES = 8;

registerWorkbenchContribution2(VibeCodeSignatureContribution.ID, VibeCodeSignatureContribution, WorkbenchPhase.AfterRestored);
