/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { SymbolKind, SymbolTag } from '../../../../editor/common/languages.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkspaceSymbol, IWorkspaceSymbolProvider, WorkspaceSymbolProviderRegistry } from '../../search/common/search.js';
import { containerLabel, extensionsOf, symbolLanguageIds } from '../common/codeSymbols/treeSitterSymbols.js';
import { IVibeCodeIndexService } from './vibeCodeIndexService.js';
import { SYMBOL_KIND_MAP } from './vibeCodeSymbolsContribution.js';
import { rangeOf } from './vibeCodeDefinitionContribution.js';

/**
 * «Перейти к символу в рабочей области» (⌘T) for the languages we read declarations of.
 *
 * The index behind «go to definition» already holds exactly what this picker asks for, so this is
 * the same knowledge shown a second way rather than a second scan of the project.
 *
 * Deliberately answers only from indexes that already exist: opening the picker must not start a
 * scan of every language in the workspace at once. In practice the index for the language you are
 * working in is built by the first jump, which is also when this becomes useful.
 */
class VibeCodeWorkspaceSymbolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeCodeWorkspaceSymbols';

	constructor(
		@IVibeCodeIndexService private readonly _index: IVibeCodeIndexService,
	) {
		super();
		const provider: IWorkspaceSymbolProvider = {
			provideWorkspaceSymbols: (search, token) => this._provide(search, token),
		};
		this._register(WorkspaceSymbolProviderRegistry.register(provider));
	}

	private async _provide(search: string, token: CancellationToken): Promise<IWorkspaceSymbol[]> {
		const found = await this._index.search(search, token);
		if (token.isCancellationRequested) {
			return [];
		}
		return found.map(({ symbol, file }): IWorkspaceSymbol => ({
			name: symbol.name,
			// The container is shown beside the name, so it must read as the language writes it.
			containerName: symbol.container.length > 0 ? containerLabel(symbol.container, languageIdOfFile(file)) : undefined,
			kind: SYMBOL_KIND_MAP[symbol.kind] ?? SymbolKind.Variable,
			tags: [] as SymbolTag[],
			location: { uri: URI.parse(file), range: rangeOf(symbol) },
		}));
	}
}

/**
 * Which language a result belongs to, taken from its extension.
 *
 * The index answers across languages at once, and the container separator differs between them, so
 * the row must be labelled with the language of the file it came from — not of the active editor.
 */
function languageIdOfFile(file: string): string {
	const lower = file.toLowerCase();
	for (const languageId of symbolLanguageIds()) {
		if (extensionsOf(languageId).some(ext => lower.endsWith(ext))) {
			return languageId;
		}
	}
	return '';
}

registerWorkbenchContribution2(VibeCodeWorkspaceSymbolsContribution.ID, VibeCodeWorkspaceSymbolsContribution, WorkbenchPhase.AfterRestored);
