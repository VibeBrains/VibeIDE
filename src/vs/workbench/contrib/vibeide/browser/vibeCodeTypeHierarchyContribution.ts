/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { SymbolKind } from '../../../../editor/common/languages.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { TypeHierarchyItem, TypeHierarchyProvider, TypeHierarchyProviderRegistry, TypeHierarchySession } from '../../typeHierarchy/common/typeHierarchy.js';
import { containerLabel, extensionsOf, symbolLanguageIds } from '../common/codeSymbols/treeSitterSymbols.js';
import { shortNameOf } from '../common/codeSymbols/nameConventions.js';
import { enclosingContainerOf } from '../common/codeSymbols/codeIndexCore.js';
import { IndexedSymbol, IVibeCodeIndexService } from './vibeCodeIndexService.js';
import { rangeOf, SYMBOL_KIND_MAP } from './vibeCodeSymbolPresentation.js';

/**
 * «Показать иерархию типов» — предки и потомки деревом.
 *
 * WHY on top of «go to implementations», which already answers one step down: a hierarchy is walked,
 * not listed. Standing on a base class in someone else's project, the useful question is usually
 * «what is under this, and under that» — and each answer is the next question.
 *
 * The data comes from the same inheritance map as `$this->`; this is the third way of showing it,
 * not a third way of computing it.
 *
 * Resolved by NAME, as everywhere here: two unrelated classes sharing a name are one node to this
 * layer, and the item's file is shown so a person can tell them apart.
 */
class VibeCodeTypeHierarchyContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeCodeTypeHierarchy';

	constructor(
		@IVibeCodeIndexService private readonly _index: IVibeCodeIndexService,
	) {
		super();
		const store = this._register(new DisposableStore());
		const provider: TypeHierarchyProvider = {
			prepareTypeHierarchy: (model, position, token) => this._prepare(model, position, token),
			provideSupertypes: (item, token) => this._supertypes(item, token),
			provideSubtypes: (item, token) => this._subtypes(item, token),
		};
		for (const languageId of symbolLanguageIds()) {
			store.add(TypeHierarchyProviderRegistry.register({ language: languageId }, provider));
		}
	}

	private async _prepare(model: ITextModel, position: IPosition, token: CancellationToken): Promise<TypeHierarchySession | undefined> {
		const languageId = model.getLanguageId();
		if (!this._index.isEnabled(languageId)) {
			return undefined;
		}
		const { symbols } = await this._index.parseModel(model);
		const word = model.getWordAtPosition(position)?.word;
		// The word under the cursor when it names a type here, otherwise the type the cursor is in —
		// so the command is useful both on a name and anywhere inside the declaration.
		const named = word && symbols.find(symbol => symbol.name === word && isType(symbol.kind));
		const target = named ?? symbols.find(symbol => symbol.name === enclosingContainerOf(symbols, position.lineNumber - 1)?.at(-1) && isType(symbol.kind));
		if (!target) {
			return undefined;
		}
		if (token.isCancellationRequested) {
			return undefined;
		}
		return {
			roots: [this._toItem({ symbol: target, file: model.uri.toString() }, languageId)],
			dispose: () => { },
		};
	}

	private async _supertypes(item: TypeHierarchyItem, token: CancellationToken): Promise<TypeHierarchyItem[]> {
		const languageId = languageOfItem(item);
		if (!languageId) {
			return [];
		}
		const chain = await this._index.ancestry(languageId, item.name, token);
		const items: TypeHierarchyItem[] = [];
		// The chain starts with the type itself; its own entry is not its own supertype.
		for (const name of chain.slice(1)) {
			const found = (await this._index.lookup(languageId, name, token)).find(entry => isType(entry.symbol.kind));
			if (found) {
				items.push(this._toItem(found, languageId));
			}
		}
		return items;
	}

	private async _subtypes(item: TypeHierarchyItem, token: CancellationToken): Promise<TypeHierarchyItem[]> {
		const languageId = languageOfItem(item);
		if (!languageId) {
			return [];
		}
		// Only the direct children: the panel expands node by node, and returning the whole subtree
		// at once would draw every descendant as a direct one.
		const all = await this._index.descendants(languageId, item.name, token);
		return all
			.filter(entry => entry.symbol.bases?.some(base => shortNameOf(base) === item.name))
			.map(entry => this._toItem(entry, languageId));
	}

	private _toItem(entry: IndexedSymbol, languageId: string): TypeHierarchyItem {
		const range = rangeOf(entry.symbol);
		return {
			_sessionId: SESSION_ID,
			_itemId: `${entry.file}#${entry.symbol.name}`,
			kind: SYMBOL_KIND_MAP[entry.symbol.kind] ?? SymbolKind.Class,
			name: entry.symbol.name,
			detail: entry.symbol.container.length > 0 ? containerLabel(entry.symbol.container, languageId) : undefined,
			uri: URI.parse(entry.file),
			range,
			selectionRange: range,
		};
	}
}

/** One session id: the hierarchy has no per-session state to keep apart. */
const SESSION_ID = 'vibeide-type-hierarchy';

function isType(kind: string): boolean {
	return kind === 'class' || kind === 'interface' || kind === 'trait' || kind === 'enum';
}

/** The language of an item, taken from the extension of the file it was found in. */
function languageOfItem(item: TypeHierarchyItem): string | undefined {
	const lower = item.uri.path.toLowerCase();
	return symbolLanguageIds().find(languageId => extensionsOf(languageId).some(extension => lower.endsWith(extension)));
}

registerWorkbenchContribution2(VibeCodeTypeHierarchyContribution.ID, VibeCodeTypeHierarchyContribution, WorkbenchPhase.AfterRestored);
