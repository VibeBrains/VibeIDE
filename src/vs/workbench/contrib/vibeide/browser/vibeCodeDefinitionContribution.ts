/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IPosition } from '../../../../editor/common/core/position.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { LocationLink } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITreeSitterLibraryService } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { CodeSymbol, extensionsOf, extractSymbols, grammarNameOf, symbolLanguageIds, SyntaxNodeLike } from '../common/codeSymbols/treeSitterSymbols.js';
import { rankDefinitions, RankedCandidate } from '../common/codeSymbols/codeDefinitionResolve.js';
import { vibeLog } from '../common/vibeLog.js';

/**
 * «Перейти к определению» for the languages whose declarations we can read, built on the same
 * grammars as the file outline.
 *
 * WHY not a language server: the usual PHP servers need PHP installed, and Phpactor additionally
 * needs the `posix` extension, which no Windows build of PHP has. The grammars here are WebAssembly
 * running inside our own process — same behaviour on Windows, macOS and Linux, nothing to install.
 * The same reasoning covers the rest: a Go, Rust or Java toolchain is a big ask for jumping to a
 * method.
 *
 * WHAT IT IS, said plainly: navigation by NAME. Nothing infers what a variable holds, so a method
 * reached through `$repo->save()` matches every `save` in the project. Ambiguity is handed to the
 * editor as several locations — it then shows a list instead of jumping somewhere arbitrary. The
 * ranking in `codeDefinitionResolve` uses the surrounding text (`Invoice::`, `$this->`, `new`) to
 * put the likely one first, which covers the common cases without pretending to be a type checker.
 *
 * A real language server for the same language wins on precision, and this provider does not fight
 * it: the editor merges results from every provider, and the setting below narrows the languages we
 * answer for when a user prefers their own extension alone.
 */

export const CONFIG_NAVIGATION_LANGUAGES = 'vibeide.codeNavigation.languages';

/** Files scanned at most per language. A larger repository gets a partial index, not a frozen editor. */
const MAX_INDEXED_FILES = 4000;

/** Files bigger than this are skipped: generated blobs cost more to parse than they inform. */
const MAX_FILE_BYTES = 1_500_000;

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
	'vendor', 'node_modules', '.git', 'storage', 'cache', 'var',
	// Build output of the other languages: thousands of generated files, none of them a source.
	'target', 'build', 'dist', 'bin', 'obj', '__pycache__', '.venv', 'venv',
]);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeideCodeNavigation',
	order: 46,
	title: localize('vibeideCodeNavigationTitle', 'VibeIDE — Навигация по коду'),
	type: 'object',
	properties: {
		[CONFIG_NAVIGATION_LANGUAGES]: {
			type: 'array',
			items: { type: 'string', enum: [...symbolLanguageIds()] },
			default: [...symbolLanguageIds()],
			description: localize('vibeide.codeNavigation.languagesDescription', 'Языки, для которых VibeIDE сам ищет объявления (переход по F12 и структура файла) — без установки языкового сервера и без самого языка на машине. Уберите язык из списка, если предпочитаете расширение с собственным сервером: точность у него выше, а результаты иначе показываются вместе.'),
			scope: ConfigurationScope.WINDOW,
		},
	},
});

/** Everything one language needs to answer: its parser and the declarations found in the project. */
interface LanguageIndex {
	readonly parser: { parse(text: string): { rootNode: unknown; delete(): void } | null; delete(): void };
	readonly byName: Map<string, RankedCandidate[]>;
}

/** Resolves when the token is cancelled, so a caller can stop waiting without stopping the work. */
function cancellationPromise(token: CancellationToken): Promise<void> {
	if (token.isCancellationRequested) {
		return Promise.resolve();
	}
	return new Promise<void>(resolve => {
		const registration = token.onCancellationRequested(() => { registration.dispose(); resolve(); });
	});
}

class VibeCodeDefinitionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeCodeDefinition';

	/** Cancels every running scan when the window goes away — never a single request. */
	private readonly _buildCancellation = this._register(new CancellationTokenSource());

	/** Built lazily per language, dropped when a file of that language changes. */
	private readonly _indexes = new Map<string, LanguageIndex>();
	private readonly _building = new Map<string, Promise<void>>();

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ITreeSitterLibraryService private readonly _treeSitter: ITreeSitterLibraryService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		const store = this._register(new DisposableStore());
		for (const languageId of symbolLanguageIds()) {
			store.add(languageFeaturesService.definitionProvider.register({ language: languageId }, {
				provideDefinition: (model, position, token) => this._provide(model, languageId, position, token),
			}));
		}
		// A stale index sends the user to a line that no longer holds the declaration, which is worse
		// than no jump at all. Cheapest correct answer: drop it and rebuild on the next request.
		store.add(this._fileService.onDidFilesChange(e => {
			const touched = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted];
			for (const languageId of [...this._indexes.keys()]) {
				const extensions = extensionsOf(languageId);
				if (touched.some(resource => extensions.some(ext => resource.path.toLowerCase().endsWith(ext)))) {
					this._dropIndex(languageId);
				}
			}
		}));
	}

	private _isEnabled(languageId: string): boolean {
		const configured = this._configuration.getValue<unknown>(CONFIG_NAVIGATION_LANGUAGES);
		return Array.isArray(configured) ? configured.includes(languageId) : true;
	}

	private async _provide(model: ITextModel, languageId: string, position: IPosition, token: CancellationToken): Promise<LocationLink[] | undefined> {
		if (!this._isEnabled(languageId)) {
			return undefined;
		}
		const word = model.getWordAtPosition(position);
		if (!word) {
			return undefined;
		}
		await this._ensureIndex(languageId, token);
		const index = this._indexes.get(languageId);
		if (!index || token.isCancellationRequested) {
			return undefined;
		}
		const ranked = rankDefinitions({
			word: word.word,
			lineText: model.getLineContent(position.lineNumber),
			wordStartColumn: word.startColumn - 1,
			enclosingContainer: this._enclosingContainer(model, languageId, position),
			languageId,
		}, index.byName);

		return ranked.map(({ file, symbol }): LocationLink => ({
			uri: URI.parse(file),
			range: {
				startLineNumber: symbol.startLine + 1,
				startColumn: symbol.startColumn + 1,
				endLineNumber: symbol.endLine + 1,
				endColumn: symbol.endColumn + 1,
			},
		}));
	}

	/**
	 * Which type the cursor sits inside, read from the file being edited.
	 *
	 * Parsed fresh rather than taken from the index: the file in the editor may differ from the file
	 * on disk, and `$this->` must mean the class as it is written right now.
	 */
	private _enclosingContainer(model: ITextModel, languageId: string, position: IPosition): readonly string[] | undefined {
		try {
			const symbols = this._symbolsOfText(languageId, model.getValue());
			const line = position.lineNumber - 1;
			// Innermost container whose range covers the cursor.
			let best: CodeSymbol | undefined;
			for (const symbol of symbols) {
				const isType = symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'trait' || symbol.kind === 'enum';
				if (isType && symbol.startLine <= line && line <= symbol.endLine) {
					if (!best || symbol.startLine >= best.startLine) { best = symbol; }
				}
			}
			return best ? [...best.container, best.name] : undefined;
		} catch {
			return undefined;
		}
	}

	/** Parse text with the parser kept alive for that language — one per keystroke would be wasteful. */
	private _symbolsOfText(languageId: string, text: string): CodeSymbol[] {
		const parser = this._indexes.get(languageId)?.parser;
		const tree = parser?.parse(text);
		if (!tree) {
			return [];
		}
		try {
			return extractSymbols(tree.rootNode as SyntaxNodeLike, languageId);
		} finally {
			tree.delete();
		}
	}

	private _dropIndex(languageId: string): void {
		// The parser holds WASM memory: dropping the index without it leaks a parser per rebuild.
		this._indexes.get(languageId)?.parser.delete();
		this._indexes.delete(languageId);
	}

	/**
	 * Build the index once, and never on the request's own cancellation token.
	 *
	 * The editor cancels a definition request freely — a keystroke, a second F12, a mouse move over
	 * another symbol. If the scan died with the request, a large project could cancel every attempt
	 * just before it finished and the feature would look permanently broken while working correctly.
	 * The scan is therefore tied to the lifetime of this contribution; the request's token only stops
	 * the caller from waiting.
	 */
	private async _ensureIndex(languageId: string, token: CancellationToken): Promise<void> {
		if (this._indexes.has(languageId)) {
			return;
		}
		let building = this._building.get(languageId);
		if (!building) {
			building = this._build(languageId).finally(() => this._building.delete(languageId));
			this._building.set(languageId, building);
		}
		await Promise.race([building, cancellationPromise(token)]);
	}

	private async _build(languageId: string): Promise<void> {
		const started = Date.now();
		const token = this._buildCancellation.token;
		let parser: LanguageIndex['parser'] | undefined;
		try {
			const [ParserClass, language] = await Promise.all([
				this._treeSitter.getParserClass(),
				this._treeSitter.getLanguagePromise(grammarNameOf(languageId)),
			]);
			if (!language) {
				return;
			}
			const created = new ParserClass();
			created.setLanguage(language);
			parser = created as unknown as LanguageIndex['parser'];

			const extensions = extensionsOf(languageId);
			const byName = new Map<string, RankedCandidate[]>();
			let scanned = 0;

			const parse = (text: string): CodeSymbol[] => {
				const tree = parser!.parse(text);
				if (!tree) {
					return [];
				}
				try {
					return extractSymbols(tree.rootNode as SyntaxNodeLike, languageId);
				} finally {
					tree.delete();
				}
			};

			const walk = async (dir: URI): Promise<void> => {
				if (token.isCancellationRequested || scanned >= MAX_INDEXED_FILES) {
					return;
				}
				const entry = await this._fileService.resolve(dir).catch(() => undefined);
				for (const child of entry?.children ?? []) {
					if (token.isCancellationRequested || scanned >= MAX_INDEXED_FILES) {
						return;
					}
					const name = child.name;
					if (child.isDirectory) {
						if (!name.startsWith('.') && !SKIPPED_DIRECTORIES.has(name)) {
							await walk(child.resource);
						}
						continue;
					}
					const lower = name.toLowerCase();
					if (!extensions.some(ext => lower.endsWith(ext)) || (child.size ?? 0) > MAX_FILE_BYTES) {
						continue;
					}
					scanned++;
					// Yield regularly: indexing a large project must not freeze the window.
					if (scanned % 40 === 0) {
						await new Promise(resolve => setTimeout(resolve, 0));
					}
					const content = await this._fileService.readFile(child.resource).catch(() => undefined);
					if (!content) {
						continue;
					}
					const file = child.resource.toString();
					for (const symbol of parse(content.value.toString())) {
						const list = byName.get(symbol.name);
						const candidate: RankedCandidate = { symbol, file, score: 0 };
						if (list) { list.push(candidate); } else { byName.set(symbol.name, [candidate]); }
					}
				}
			};

			for (const folder of this._workspace.getWorkspace().folders) {
				await walk(folder.uri);
			}
			if (token.isCancellationRequested) {
				parser.delete();
				return;
			}
			this._indexes.set(languageId, { parser, byName });
			vibeLog.debug('codeDefinition', `индекс ${languageId}: ${byName.size} имён из ${scanned} файлов за ${Date.now() - started} мс`);
		} catch (err) {
			parser?.delete();
			vibeLog.warn('codeDefinition', `индекс ${languageId} построить не удалось: ${err}`);
		}
	}

	override dispose(): void {
		this._buildCancellation.cancel();
		for (const languageId of [...this._indexes.keys()]) {
			this._dropIndex(languageId);
		}
		super.dispose();
	}
}

registerWorkbenchContribution2(VibeCodeDefinitionContribution.ID, VibeCodeDefinitionContribution, WorkbenchPhase.AfterRestored);
