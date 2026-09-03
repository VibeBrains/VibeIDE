/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { Position } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Location } from '../../../../editor/common/languages.js';
import { USUAL_WORD_SEPARATORS } from '../../../../editor/common/core/wordHelper.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ISearchService, QueryType, resultIsMatch } from '../../../services/search/common/search.js';
import { extensionsOf, symbolLanguageIds } from '../common/codeSymbols/treeSitterSymbols.js';
import { IVibeCodeIndexService } from './vibeCodeIndexService.js';
import { rangeOf } from './vibeCodeSymbolPresentation.js';
import { vibeLog } from '../common/vibeLog.js';

/**
 * «Найти все ссылки» (⇧F12) for the languages we read declarations of.
 *
 * WHAT IT IS, and the caller cannot see this from the result: these are occurrences of the NAME, not
 * uses of that particular declaration. Without types, `save()` called on an unknown variable belongs
 * to no class in particular — so listing every `save` is the honest answer, while filtering to one
 * class would quietly hide real call sites.
 *
 * Two things make the list better than a plain text search, and they are the reason this exists at
 * all rather than «just use search»:
 *   - it is restricted to source files of that language, so a name inside a changelog or a lockfile
 *     does not turn up as a reference;
 *   - whole-word and case-sensitive, so `pay` does not match `payment` or `Pay`;
 *   - the declarations themselves are known from the index and reported first, which is what people
 *     look for when they open the list.
 */

/**
 * Ceiling on occurrences. The references pane is read by a person; a name with more hits than this
 * is one where the question «where is it used» has no useful answer anyway.
 */
const MAX_REFERENCES = 2000;

class VibeCodeReferencesContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeCodeReferences';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IVibeCodeIndexService private readonly _index: IVibeCodeIndexService,
		@ISearchService private readonly _searchService: ISearchService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
		const store = this._register(new DisposableStore());
		for (const languageId of symbolLanguageIds()) {
			store.add(languageFeaturesService.referenceProvider.register({ language: languageId }, {
				provideReferences: (model, position, context, token) =>
					this._provide(model, languageId, position, context.includeDeclaration, token),
			}));
		}
	}

	private async _provide(model: ITextModel, languageId: string, position: Position, includeDeclaration: boolean, token: CancellationToken): Promise<Location[] | undefined> {
		if (!this._index.isEnabled(languageId)) {
			return undefined;
		}
		const word = model.getWordAtPosition(position);
		if (!word) {
			return undefined;
		}
		const name = word.word.replace(/^\$/, '');
		const folders = this._workspace.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}

		const declarations: Location[] = [];
		if (includeDeclaration) {
			for (const entry of await this._index.lookup(languageId, name, token)) {
				declarations.push({ uri: URI.parse(entry.file), range: rangeOf(entry.symbol) });
			}
		}
		if (token.isCancellationRequested) {
			return undefined;
		}

		const occurrences = await this._occurrences(name, languageId, folders.map(f => f.uri), token);
		// Declarations first: «where is this declared» is the question people bring to this list, and
		// the rest is the answer to «and where is it used».
		const seen = new Set(declarations.map(keyOf));
		return [...declarations, ...occurrences.filter(location => !seen.has(keyOf(location)))];
	}

	private async _occurrences(name: string, languageId: string, folders: readonly URI[], token: CancellationToken): Promise<Location[]> {
		const extensions = extensionsOf(languageId);
		if (extensions.length === 0) {
			return [];
		}
		// Restricting to this language's sources is what separates a reference list from a text
		// search: the same word in a lockfile or a changelog is not a use of this method.
		const includePattern: Record<string, boolean> = {};
		for (const extension of extensions) {
			includePattern[`**/*${extension}`] = true;
		}
		try {
			const result = await this._searchService.textSearch({
				type: QueryType.Text,
				contentPattern: {
					pattern: escapeRegExpCharacters(name),
					isRegExp: true,
					isWordMatch: true,
					wordSeparators: USUAL_WORD_SEPARATORS,
					isCaseSensitive: true,
				},
				folderQueries: folders.map(folder => ({ folder })),
				includePattern,
				maxResults: MAX_REFERENCES,
			}, token);

			const out: Location[] = [];
			for (const fileMatch of result.results) {
				for (const match of fileMatch.results ?? []) {
					if (!resultIsMatch(match)) {
						continue;
					}
					for (const location of match.rangeLocations) {
						const source = location.source;
						out.push({
							uri: fileMatch.resource,
							range: {
								// Search reports zero-based lines; the editor counts from one.
								startLineNumber: source.startLineNumber + 1,
								startColumn: source.startColumn + 1,
								endLineNumber: source.endLineNumber + 1,
								endColumn: source.endColumn + 1,
							},
						});
					}
				}
			}
			return out;
		} catch (err) {
			// A failed search must not swallow the declarations we already know about.
			vibeLog.warn('codeReferences', `поиск использований «${name}» не удался: ${err}`);
			return [];
		}
	}
}

function keyOf(location: Location): string {
	return `${location.uri.toString()}:${location.range.startLineNumber}:${location.range.startColumn}`;
}

registerWorkbenchContribution2(VibeCodeReferencesContribution.ID, VibeCodeReferencesContribution, WorkbenchPhase.AfterRestored);
