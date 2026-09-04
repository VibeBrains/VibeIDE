/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { CompletionContext, CompletionItem, CompletionItemKind, CompletionList } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { CodeSymbol, containerLabel, memberAccessOperators, symbolLanguageIds } from '../common/codeSymbols/treeSitterSymbols.js';
import { enclosingContainerOf } from '../common/codeSymbols/codeIndexCore.js';
import { CallShape, readCallShape } from '../common/codeSymbols/codeDefinitionResolve.js';
import { IVibeCodeIndexService } from './vibeCodeIndexService.js';

/**
 * Автодополнение по тому же индексу объявлений, что и переход.
 *
 * WHY: for a language without a server there is no completion at all — the editor falls back to
 * words already present in the file. The index already knows every class and every method of the
 * project, which is most of what a completion list is for.
 *
 * WHAT IT KNOWS, and the list says so in each row: names, not types. After `$this->` we can offer
 * the members of the enclosing class exactly, and after `Invoice::` the members of a class named
 * `Invoice`. After `$repo->` we cannot know what `$repo` holds, so the honest answer is «members of
 * the project, sorted by nothing in particular» — offered, but never presented as certainty.
 */

/** Ceiling on rows. The list is read by a person, and the editor re-filters it on every keystroke. */
const MAX_ITEMS = 300;

/**
 * How much must be typed before we offer members of unknown ownership.
 *
 * With no prefix at all, `$repo->` matches every member in the project — a wall of names that buries
 * whatever the editor itself had to offer. Two characters is enough to mean something.
 */
const MIN_GUESS_PREFIX = 2;

const KIND_MAP: Readonly<Record<CodeSymbol['kind'], CompletionItemKind>> = {
	namespace: CompletionItemKind.Module,
	class: CompletionItemKind.Class,
	interface: CompletionItemKind.Interface,
	trait: CompletionItemKind.Class,
	enum: CompletionItemKind.Enum,
	method: CompletionItemKind.Method,
	function: CompletionItemKind.Function,
	property: CompletionItemKind.Property,
	constant: CompletionItemKind.Constant,
	variable: CompletionItemKind.Variable,
};

const TYPE_KINDS: ReadonlySet<CodeSymbol['kind']> = new Set<CodeSymbol['kind']>(['class', 'interface', 'trait', 'enum']);
const MEMBER_KINDS: ReadonlySet<CodeSymbol['kind']> = new Set<CodeSymbol['kind']>(['method', 'property', 'constant']);

class VibeCodeCompletionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeCodeCompletion';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IVibeCodeIndexService private readonly _index: IVibeCodeIndexService,
	) {
		super();
		const store = this._register(new DisposableStore());
		for (const languageId of symbolLanguageIds()) {
			store.add(languageFeaturesService.completionProvider.register({ language: languageId }, {
				_debugDisplayName: 'vibeCodeCompletion',
				// The access operators of this language, so `->` and `::` open the list where they mean
				// «member of» and nowhere else.
				triggerCharacters: memberAccessOperators(languageId).map(operator => operator.slice(-1)),
				provideCompletionItems: (model, position, context, token) => this._provide(model, languageId, position, context, token),
			}));
		}
	}

	private async _provide(model: ITextModel, languageId: string, position: IPosition, _context: CompletionContext, token: CancellationToken): Promise<CompletionList | undefined> {
		if (!this._index.isEnabled(languageId)) {
			return undefined;
		}
		const word = model.getWordUntilPosition(position);
		const range: IRange = {
			startLineNumber: position.lineNumber, startColumn: word.startColumn,
			endLineNumber: position.lineNumber, endColumn: word.endColumn,
		};
		const lineText = model.getLineContent(position.lineNumber);
		const { shape, owner } = readCallShape(lineText, word.startColumn - 1, languageId);

		const candidates = await this._candidates(model, languageId, shape, owner, position, word.word, token);
		if (token.isCancellationRequested || candidates.length === 0) {
			return undefined;
		}

		const seen = new Set<string>();
		const suggestions: CompletionItem[] = [];
		for (const { symbol, exact } of candidates) {
			const key = `${symbol.kind}:${symbol.name}:${symbol.container.join('.')}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			suggestions.push({
				// The parameter list belongs on the label: choosing between two methods usually means
				// choosing by what they take.
				label: symbol.params ? { label: `${symbol.name}${symbol.params}`, description: undefined } : symbol.name,
				filterText: symbol.name,
				kind: KIND_MAP[symbol.kind],
				// Where it comes from — the row has to carry this, because two identical names from
				// different classes are otherwise indistinguishable in the list.
				detail: symbol.container.length > 0 ? containerLabel(symbol.container, languageId) : undefined,
				documentation: exact ? undefined : { value: localize('vibeide.codeNavigation.completionGuess', 'Совпадение по имени: тип переменной неизвестен, поэтому предложены объявления со всего проекта.') },
				insertText: symbol.name,
				range,
				// Members of the known class come first; project-wide guesses after them.
				// `!` sorts before `$`: after `$this->` the members of this class must outrank the
				// language's superglobals, which otherwise fill the whole first screen.
				sortText: exact ? `!${symbol.name}` : `~${symbol.name}`,
			});
			if (suggestions.length >= MAX_ITEMS) {
				break;
			}
		}
		// `incomplete` only when the list was cut short: a complete answer must not make the editor ask
		// again on the next keystroke.
		return { suggestions, incomplete: suggestions.length >= MAX_ITEMS };
	}

	/**
	 * Which declarations to offer, and whether we actually know they belong here.
	 *
	 * `exact` is the honest half: true only when the source names the owner (`$this->`, `Invoice::`),
	 * false when we are offering the project because the type of a variable is unknowable.
	 */
	private async _candidates(model: ITextModel, languageId: string, shape: CallShape, owner: string | undefined, position: IPosition, prefix: string, token: CancellationToken): Promise<{ symbol: CodeSymbol; exact: boolean }[]> {
		// The typed prefix is passed to the index instead of being re-filtered here: with `incomplete`
		// the editor asks again after every keystroke, so a full pass per letter is the difference
		// between a list that appears and one that lags behind the typing.
		// Only this language: a PHP file has no use for Ruby methods.
		const all = await this._index.search(prefix, token, languageId);
		if (token.isCancellationRequested) {
			return [];
		}

		if (shape === 'this-member' || shape === 'static-member' || shape === 'instance-member') {
			const ownerName = shape === 'this-member'
				? (await this._enclosingType(model, position))?.at(-1)
				: owner ? baseName(owner) : undefined;

			if (ownerName) {
				// Members of the class AND of everything it inherits — an inherited method is as much
				// «mine» as a declared one, and offering only the latter is how a list looks broken.
				const chain = await this._index.ancestry(languageId, ownerName, token);
				const rank = new Map(chain.map((name, index) => [name, index]));
				const own = all
					.filter(entry => MEMBER_KINDS.has(entry.symbol.kind) && rank.has(entry.symbol.container.at(-1) ?? ''))
					.sort((a, b) => (rank.get(a.symbol.container.at(-1)!) ?? 0) - (rank.get(b.symbol.container.at(-1)!) ?? 0));
				if (own.length > 0) {
					// The source names the owner, so these members are not a guess.
					return own.map(entry => ({ symbol: entry.symbol, exact: true }));
				}
			}
			// `$repo->` — the variable's type is unknowable here, so every member in the project is a
			// candidate. On an empty prefix that is a dump rather than a suggestion, so guesses wait
			// until the user has typed enough to mean something.
			if (prefix.length < MIN_GUESS_PREFIX) {
				return [];
			}
			return all.filter(entry => MEMBER_KINDS.has(entry.symbol.kind)).map(entry => ({ symbol: entry.symbol, exact: false }));
		}

		// Anywhere else a bare name is most likely a type or a free function.
		return all
			.filter(entry => TYPE_KINDS.has(entry.symbol.kind) || entry.symbol.kind === 'function')
			.map(entry => ({ symbol: entry.symbol, exact: true }));
	}

	/** The type declaration the cursor sits in, read from the editor's own text. */
	private async _enclosingType(model: ITextModel, position: IPosition): Promise<readonly string[] | undefined> {
		const { symbols } = await this._index.parseModel(model);
		return enclosingContainerOf(symbols, position.lineNumber - 1);
	}
}

function baseName(name: string): string {
	const parts = name.split(/[\\.]|::/);
	return parts[parts.length - 1] || name;
}

registerWorkbenchContribution2(VibeCodeCompletionContribution.ID, VibeCodeCompletionContribution, WorkbenchPhase.AfterRestored);
