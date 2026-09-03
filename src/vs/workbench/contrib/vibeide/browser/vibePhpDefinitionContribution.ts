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
import { ITreeSitterLibraryService } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { CodeSymbol, extractSymbols, SyntaxNodeLike } from '../common/codeSymbols/treeSitterSymbols.js';
import { rankDefinitions, RankedCandidate } from '../common/codeSymbols/phpDefinitionResolve.js';
import { vibeLog } from '../common/vibeLog.js';

/**
 * «Перейти к определению» for PHP, built on the same grammar as the file outline.
 *
 * WHY not a language server: the usual PHP servers need PHP installed, and Phpactor additionally
 * needs the `posix` extension, which no Windows build of PHP has. The grammar here is WebAssembly
 * running inside our own process — same behaviour on Windows, macOS and Linux, nothing to install.
 *
 * WHAT IT IS, said plainly: navigation by NAME. Nothing infers what a variable holds, so a method
 * reached through `$repo->save()` matches every `save` in the project. Ambiguity is handed to the
 * editor as several locations — it then shows a list instead of jumping somewhere arbitrary. The
 * ranking in `phpDefinitionResolve` uses the surrounding text (`Invoice::`, `$this->`, `new`) to put
 * the likely one first, which covers the common cases without pretending to be a type checker.
 */

const LANGUAGE_ID = 'php';

/** Files scanned at most. A repository larger than this gets a partial index, not a frozen editor. */
const MAX_INDEXED_FILES = 4000;

/** Files bigger than this are skipped: generated PHP blobs cost more to parse than they inform. */
const MAX_FILE_BYTES = 1_500_000;

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['vendor', 'node_modules', '.git', 'storage', 'cache', 'var']);

class VibePhpDefinitionContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibePhpDefinition';

	/** name → declarations of that name. Built lazily, refreshed when PHP files change. */
	private _index: Map<string, RankedCandidate[]> | undefined;
	private _building: Promise<void> | undefined;

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ITreeSitterLibraryService private readonly _treeSitter: ITreeSitterLibraryService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
		const store = this._register(new DisposableStore());
		store.add(languageFeaturesService.definitionProvider.register({ language: LANGUAGE_ID }, {
			provideDefinition: (model, position, token) => this._provide(model, position, token),
		}));
		// A stale index sends the user to a line that no longer holds the declaration, which is worse
		// than no jump at all. Cheapest correct answer: drop it and rebuild on the next request.
		store.add(this._fileService.onDidFilesChange(e => {
			if (e.rawAdded.some(isPhp) || e.rawUpdated.some(isPhp) || e.rawDeleted.some(isPhp)) {
				this._index = undefined;
			}
		}));
	}

	private async _provide(model: ITextModel, position: IPosition, token: CancellationToken): Promise<LocationLink[] | undefined> {
		const word = model.getWordAtPosition(position);
		if (!word) {
			return undefined;
		}
		await this._ensureIndex(token);
		if (!this._index || token.isCancellationRequested) {
			return undefined;
		}
		const lineText = model.getLineContent(position.lineNumber);
		const ranked = rankDefinitions({
			word: word.word,
			lineText,
			wordStartColumn: word.startColumn - 1,
			enclosingContainer: this._enclosingContainer(model, position),
		}, this._index);

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
	 * Which class the cursor sits inside, read from the file being edited.
	 *
	 * Parsed fresh rather than taken from the index: the file in the editor may differ from the file
	 * on disk, and `$this->` must mean the class as it is written right now.
	 */
	private _enclosingContainer(model: ITextModel, position: IPosition): readonly string[] | undefined {
		try {
			const symbols = this._symbolsOfText(model.getValue());
			const line = position.lineNumber - 1;
			// Innermost container whose range covers the cursor.
			let best: CodeSymbol | undefined;
			for (const symbol of symbols) {
				if (symbol.startLine <= line && line <= symbol.endLine && (symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'trait' || symbol.kind === 'enum')) {
					if (!best || symbol.startLine >= best.startLine) { best = symbol; }
				}
			}
			return best ? [...best.container, best.name] : undefined;
		} catch {
			return undefined;
		}
	}

	private _parser: { parse(text: string): { rootNode: unknown; delete(): void } | null; delete(): void } | undefined;

	/** Parse text with a parser kept alive between calls — creating one per keystroke is wasteful. */
	private _symbolsOfText(text: string): CodeSymbol[] {
		const parser = this._parser;
		if (!parser) {
			return [];
		}
		const tree = parser.parse(text);
		if (!tree) {
			return [];
		}
		try {
			return extractSymbols(tree.rootNode as SyntaxNodeLike, LANGUAGE_ID);
		} finally {
			tree.delete();
		}
	}

	private async _ensureIndex(token: CancellationToken): Promise<void> {
		if (this._index) {
			return;
		}
		if (!this._building) {
			this._building = this._build(token).finally(() => { this._building = undefined; });
		}
		await this._building;
	}

	private async _build(token: CancellationToken): Promise<void> {
		const started = Date.now();
		try {
			const [ParserClass, language] = await Promise.all([
				this._treeSitter.getParserClass(),
				this._treeSitter.getLanguagePromise(LANGUAGE_ID),
			]);
			if (!language) {
				return;
			}
			const parser = new ParserClass();
			parser.setLanguage(language);
			this._parser = parser as unknown as typeof this._parser;

			const index = new Map<string, RankedCandidate[]>();
			let scanned = 0;

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
					if (!name.endsWith('.php') || (child.size ?? 0) > MAX_FILE_BYTES) {
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
					for (const symbol of this._symbolsOfText(content.value.toString())) {
						const list = index.get(symbol.name);
						const candidate: RankedCandidate = { symbol, file, score: 0 };
						if (list) { list.push(candidate); } else { index.set(symbol.name, [candidate]); }
					}
				}
			};

			for (const folder of this._workspace.getWorkspace().folders) {
				await walk(folder.uri);
			}
			if (!token.isCancellationRequested) {
				this._index = index;
				vibeLog.debug('phpDefinition', `индекс PHP: ${index.size} имён из ${scanned} файлов за ${Date.now() - started} мс`);
			}
		} catch (err) {
			vibeLog.warn('phpDefinition', `индекс PHP построить не удалось: ${err}`);
		}
	}

	override dispose(): void {
		// The parser holds WASM memory; without this it survives the window that created it.
		this._parser?.delete();
		this._parser = undefined;
		super.dispose();
	}
}

function isPhp(resource: URI): boolean {
	return resource.path.endsWith('.php');
}

registerWorkbenchContribution2(VibePhpDefinitionContribution.ID, VibePhpDefinitionContribution, WorkbenchPhase.AfterRestored);
