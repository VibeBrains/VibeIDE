/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITreeSitterLibraryService } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import * as glob from '../../../../base/common/glob.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { getExcludes, ISearchConfiguration } from '../../../services/search/common/search.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { CodeSymbol, extensionsOf, extractSymbols, grammarNameOf, indexKeyOf, isInsideSpans, nonCodeSpans, supportsSymbolExtraction, symbolLanguageIds, SyntaxNodeLike, TextSpan } from '../common/codeSymbols/treeSitterSymbols.js';
import { collectMatches, createSymbolIndex, IndexedSymbol, preferOpenBuffers, replaceFileSymbols, SymbolIndex } from '../common/codeSymbols/codeIndexCore.js';
import { vibeLog } from '../common/vibeLog.js';

/**
 * The one index of declarations behind every navigation surface: «go to definition», «go to symbol
 * in workspace» and the hover.
 *
 * WHY a service and not a field on the provider it started in: three surfaces need the same
 * knowledge, and three private copies would mean three scans of the project and three answers that
 * can disagree with each other.
 *
 * WHY tree-sitter and not a language server: the usual PHP servers need PHP installed, and Phpactor
 * additionally needs the `posix` extension, which no Windows build of PHP has. These grammars are
 * WebAssembly running inside our own process — nothing to install, same behaviour on three OSes.
 *
 * WHAT IT IS NOT: a type checker. It knows what files DECLARE, never what a variable holds. Callers
 * are expected to say so out loud rather than imply precision the index cannot have.
 */

export const CONFIG_NAVIGATION_LANGUAGES = 'vibeide.codeNavigation.languages';
export const CONFIG_MAX_FILES = 'vibeide.codeNavigation.maxIndexedFiles';
export const CONFIG_MAX_FILE_KB = 'vibeide.codeNavigation.maxFileSizeKB';
export const CONFIG_EXCLUDED_FOLDERS = 'vibeide.codeNavigation.excludedFolders';

/**
 * Files scanned per language by default.
 *
 * Raised from 4000 after a real project hit the ceiling: the walk simply stopped part-way, so a
 * declaration that existed was absent from the index and «go to definition» reported nothing —
 * indistinguishable from «there is no such method». A partial index must be rare and, when it
 * happens, said out loud (see `truncated` in the status).
 */
const DEFAULT_MAX_FILES = 20000;
const DEFAULT_MAX_FILE_KB = 1500;

/**
 * Ceiling on rows handed to the symbol picker.
 *
 * Not a setting: it is not a matter of taste but of what a list can usefully show. The picker scores
 * and sorts everything it is given on every keystroke, and a person reads the first screen of it.
 */
const MAX_SEARCH_RESULTS = 512;

/**
 * How many files are re-read to strip comment matches out of a reference list.
 *
 * A ceiling because this is a nicety, not the answer: past it the list is shown unfiltered rather
 * than made slow. Reference lists that big are read by machines, not people.
 */
const MAX_FILTERED_FILES = 200;

/**
 * Folders that hold dependencies or build output in the supported languages. A default, not a law:
 * the setting exists because every monorepo draws this line somewhere else.
 */
const DEFAULT_EXCLUDED_FOLDERS = [
	// Dependencies and build output only. `bin` and `var` were here and are now not: in PHP projects
	// they routinely hold real sources (console entry points, application code), and excluding them
	// made declarations invisible with no way for the user to guess why.
	'vendor', 'node_modules', 'storage', 'cache',
	'target', 'build', 'dist', 'obj', '__pycache__', '.venv', 'venv',
];

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
			description: localize('vibeide.codeNavigation.languagesDescription', 'Языки, для которых VibeIDE сам ищет объявления — переход по F12, структура файла, поиск символов (⌘T) и подсказка при наведении. Работает без языкового сервера и без самого языка на машине. Уберите язык из списка, если предпочитаете расширение с собственным сервером: точность у него выше, а результаты иначе показываются вместе.'),
			scope: ConfigurationScope.WINDOW,
		},
		[CONFIG_MAX_FILES]: {
			type: 'number',
			default: DEFAULT_MAX_FILES,
			minimum: 100,
			description: localize('vibeide.codeNavigation.maxIndexedFilesDescription', 'Сколько файлов одного языка обходить при построении индекса объявлений. Больше — полнее переход в огромном репозитории, дольше первое построение. Индекс строится один раз и дальше обновляется только по изменившимся файлам.'),
			scope: ConfigurationScope.WINDOW,
		},
		[CONFIG_MAX_FILE_KB]: {
			type: 'number',
			default: DEFAULT_MAX_FILE_KB,
			minimum: 16,
			description: localize('vibeide.codeNavigation.maxFileSizeKBDescription', 'Файлы крупнее этого размера (в килобайтах) пропускаются: как правило это сгенерированные простыни, разбор которых стоит дороже, чем даёт.'),
			scope: ConfigurationScope.WINDOW,
		},
		[CONFIG_EXCLUDED_FOLDERS]: {
			type: 'array',
			items: { type: 'string' },
			default: DEFAULT_EXCLUDED_FOLDERS,
			description: localize('vibeide.codeNavigation.excludedFoldersDescription', 'Папки, которые не попадают в индекс объявлений: зависимости и результаты сборки. Имя папки на любом уровне, без путей. Папки, начинающиеся с точки, пропускаются всегда.'),
			scope: ConfigurationScope.WINDOW,
		},
	},
});

export { IndexedSymbol };

/** A language's index as a person would want it described. */
export interface IndexStatus {
	readonly languageId: string;
	readonly enabled: boolean;
	readonly built: boolean;
	readonly building: boolean;
	readonly names: number;
	readonly files: number;
	/** The walk stopped at the file limit, so the index is knowingly incomplete. */
	readonly truncated: boolean;
}

export interface IVibeCodeIndexService {
	readonly _serviceBrand: undefined;
	/** Is this language ours to answer for, per the user's setting? */
	isEnabled(languageId: string): boolean;
	/** Declarations of one name, across the project. Empty when the name is unknown. */
	lookup(languageId: string, name: string, token: CancellationToken): Promise<readonly IndexedSymbol[]>;
	/** Every declaration whose name matches the filter — for «go to symbol in workspace». */
	search(query: string, token: CancellationToken): Promise<readonly IndexedSymbol[]>;
	/**
	 * Declarations of a single text, parsed on the spot — for the file being edited.
	 *
	 * Asynchronous because the grammar may still be loading. It deliberately does NOT depend on the
	 * project index: highlighting a name and reading the class around the cursor must work in a file
	 * whose language has never been scanned.
	 */
	/** What the index currently holds, per language — for the «состояние индекса» command. */
	status(): readonly IndexStatus[];
	/** Throw the index away so the next request rebuilds it from disk. */
	rebuild(): void;
	parseText(languageId: string, text: string): Promise<CodeSymbol[]>;
	/** Declarations plus the comment and string spans of the same text, from a single parse. */
	parseFile(languageId: string, text: string): Promise<{ symbols: CodeSymbol[]; nonCode: TextSpan[] }>;
	/**
	 * Drop the positions that fall inside comments or string literals.
	 *
	 * Takes zero-based positions grouped by file and returns the same shape. A file it cannot read
	 * is left untouched — filtering is an improvement, and failing to improve must not lose data.
	 */
	filterToCode(languageId: string, files: ReadonlyMap<string, readonly { line: number; column: number }[]>, token: CancellationToken): Promise<Map<string, Set<string>>>;
}

export const IVibeCodeIndexService = createDecorator<IVibeCodeIndexService>('vibeCodeIndexService');

/** One language's parser plus what the project declares in it. */
interface LanguageIndex {
	readonly parser: { parse(text: string): { rootNode: unknown; delete(): void } | null; delete(): void };
	readonly symbols: SymbolIndex;
}

/** Parse text with a parser, always freeing the tree: WASM memory is not reclaimed by the GC. */
function parseWith(parser: LanguageIndex['parser'], languageId: string, text: string): CodeSymbol[] {
	const tree = parser.parse(text);
	if (!tree) {
		return [];
	}
	try {
		return extractSymbols(tree.rootNode as SyntaxNodeLike, languageId);
	} finally {
		tree.delete();
	}
}

class VibeCodeIndexService extends Disposable implements IVibeCodeIndexService {

	declare readonly _serviceBrand: undefined;

	/** Cancels running scans when the window goes away — never a single request. */
	private readonly _scanCancellation = this._register(new CancellationTokenSource());
	private readonly _indexes = new Map<string, LanguageIndex>();
	/** Parsed open buffers, keyed by file, invalidated by the model's version. */
	private readonly _openModelCache = new Map<string, { version: number; symbols: CodeSymbol[]; languageId: string }>();
	/** One parser per language, shared by the scan and by every open-file parse. */
	private readonly _parsers = new Map<string, LanguageIndex['parser']>();
	private readonly _parserLoads = new Map<string, Promise<LanguageIndex['parser'] | undefined>>();
	private readonly _building = new Map<string, Promise<void>>();
	/** Languages whose walk hit the file ceiling — their index is incomplete and says so. */
	private readonly _truncated = new Set<string>();

	constructor(
		@ITreeSitterLibraryService private readonly _treeSitter: ITreeSitterLibraryService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IModelService private readonly _modelService: IModelService,
		@IProgressService private readonly _progressService: IProgressService,
	) {
		super();
		// Warm up the language of every file that opens. Without this the index exists only after the
		// first F12, so ⌘T and references answer nothing until then — and «nothing» reads as «this
		// language is not supported», not as «not ready yet».
		//
		// Existing models are walked as well, not just the event: this service is created lazily, by
		// which time the editors restored at startup are already open. Subscribing without handling
		// the current state means the files the user actually has open are the ones never warmed.
		const warmUp = (languageId: string) => {
			if (supportsSymbolExtraction(languageId) && this.isEnabled(languageId) && !this._indexes.has(languageId)) {
				void this._ensureIndex(languageId, CancellationToken.None);
			}
		};
		for (const model of this._modelService.getModels()) {
			warmUp(model.getLanguageId());
		}
		this._register(this._modelService.onModelAdded(model => warmUp(model.getLanguageId())));
		this._register(this._modelService.onModelLanguageChanged(e => warmUp(e.model.getLanguageId())));
		// Only the changed files are re-read. Dropping the whole index here would make every save
		// cost the next jump a full walk of the project, which is what this replaces.
		this._register(this._fileService.onDidFilesChange(e => {
			for (const [languageId, index] of this._indexes) {
				const extensions = extensionsOf(languageId);
				const matches = (resource: URI) => extensions.some(ext => resource.path.toLowerCase().endsWith(ext));
				for (const resource of e.rawDeleted.filter(matches)) {
					replaceFileSymbols(index.symbols, resource.toString(), [], name => indexKeyOf(name, languageId));
				}
				const touched = [...e.rawAdded, ...e.rawUpdated].filter(matches);
				if (touched.length > 0) {
					void this._reindexFiles(languageId, index, touched);
				}
			}
		}));
		this._register(this._configuration.onDidChangeConfiguration(e => {
			// Limits and exclusions decide what the index contains, so a change invalidates it.
			if (e.affectsConfiguration(CONFIG_MAX_FILES) || e.affectsConfiguration(CONFIG_MAX_FILE_KB) || e.affectsConfiguration(CONFIG_EXCLUDED_FOLDERS)) {
				for (const languageId of [...this._indexes.keys()]) {
					this._disposeIndex(languageId);
				}
			}
		}));
	}

	status(): readonly IndexStatus[] {
		return symbolLanguageIds().map(languageId => {
			const index = this._indexes.get(languageId);
			return {
				languageId,
				enabled: this.isEnabled(languageId),
				built: !!index,
				building: this._building.has(languageId),
				names: index?.symbols.byName.size ?? 0,
				files: index?.symbols.byFile.size ?? 0,
				truncated: this._truncated.has(languageId),
			};
		});
	}

	rebuild(): void {
		for (const languageId of [...this._indexes.keys()]) {
			this._disposeIndex(languageId);
		}
	}

	isEnabled(languageId: string): boolean {
		const configured = this._configuration.getValue<unknown>(CONFIG_NAVIGATION_LANGUAGES);
		return Array.isArray(configured) ? configured.includes(languageId) : true;
	}

	async parseText(languageId: string, text: string): Promise<CodeSymbol[]> {
		return (await this.parseFile(languageId, text)).symbols;
	}

	async parseFile(languageId: string, text: string): Promise<{ symbols: CodeSymbol[]; nonCode: TextSpan[] }> {
		const parser = await this._ensureParser(languageId);
		if (!parser) {
			return { symbols: [], nonCode: [] };
		}
		const tree = parser.parse(text);
		if (!tree) {
			return { symbols: [], nonCode: [] };
		}
		try {
			const root = tree.rootNode as SyntaxNodeLike;
			// One parse for both: the highlighter needs the declarations and the comment spans at once.
			return { symbols: extractSymbols(root, languageId), nonCode: nonCodeSpans(root) };
		} finally {
			tree.delete();
		}
	}

	async filterToCode(languageId: string, files: ReadonlyMap<string, readonly { line: number; column: number }[]>, token: CancellationToken): Promise<Map<string, Set<string>>> {
		const out = new Map<string, Set<string>>();
		let parsed = 0;
		for (const [file, positions] of files) {
			if (token.isCancellationRequested || parsed >= MAX_FILTERED_FILES) {
				break;
			}
			const text = await this._textOf(file);
			if (text === undefined) {
				continue;
			}
			parsed++;
			const { nonCode } = await this.parseFile(languageId, text);
			if (nonCode.length === 0) {
				continue;
			}
			const dropped = new Set<string>();
			for (const position of positions) {
				if (isInsideSpans(nonCode, position.line, position.column)) {
					dropped.add(`${position.line}:${position.column}`);
				}
			}
			if (dropped.size > 0) {
				out.set(file, dropped);
			}
		}
		return out;
	}

	/** The editor's copy of a file if it is open, the disk otherwise. */
	private async _textOf(file: string): Promise<string | undefined> {
		for (const model of this._modelService.getModels()) {
			if (!model.isDisposed() && model.uri.toString() === file) {
				return model.getValue();
			}
		}
		const content = await this._fileService.readFile(URI.parse(file)).catch(() => undefined);
		return content?.value.toString();
	}

	/**
	 * The parser for a language, created once and kept.
	 *
	 * Separate from the index on purpose: the index is a scan of the project, while parsing the open
	 * file is needed immediately and regardless of whether that scan ever ran.
	 */
	private async _ensureParser(languageId: string): Promise<LanguageIndex['parser'] | undefined> {
		const existing = this._parsers.get(languageId);
		if (existing) {
			return existing;
		}
		let pending = this._parserLoads.get(languageId);
		if (!pending) {
			pending = (async () => {
				const [ParserClass, language] = await Promise.all([
					this._treeSitter.getParserClass(),
					this._treeSitter.getLanguagePromise(grammarNameOf(languageId)),
				]);
				if (!language) {
					return undefined;
				}
				const created = new ParserClass();
				created.setLanguage(language);
				const parser = created as unknown as LanguageIndex['parser'];
				this._parsers.set(languageId, parser);
				return parser;
			})().catch(err => {
				vibeLog.warn('codeIndex', `грамматика ${languageId} не загрузилась: ${err}`);
				return undefined;
			}).finally(() => this._parserLoads.delete(languageId));
			this._parserLoads.set(languageId, pending);
		}
		return pending;
	}

	async lookup(languageId: string, name: string, token: CancellationToken): Promise<readonly IndexedSymbol[]> {
		const index = await this._ensureIndex(languageId, token);
		if (!index) {
			return [];
		}
		// PHP calls `ProcessInputData()` and `processInputData()` the same method, so the lookup key —
		// not the displayed name — decides what matches.
		const key = indexKeyOf(name, languageId);
		const fromDisk = index.symbols.byName.get(key) ?? [];
		const open = (await this._openModelSymbols(languageId)).filter(entry => indexKeyOf(entry.symbol.name, languageId) === key);
		return preferOpenBuffers(fromDisk, open);
	}

	async search(query: string, token: CancellationToken): Promise<readonly IndexedSymbol[]> {
		const needle = query.trim().toLowerCase();
		const out: IndexedSymbol[] = [];
		for (const languageId of symbolLanguageIds()) {
			if (!this.isEnabled(languageId) || out.length >= MAX_SEARCH_RESULTS) {
				continue;
			}
			// Only languages already indexed answer here: opening the symbol picker must not kick off
			// a scan of every language in the workspace at once.
			const index = this._indexes.get(languageId);
			if (!index || token.isCancellationRequested) {
				continue;
			}
			// Open buffers are grouped once. Filtering the whole list per name turned the picker into
			// a quadratic scan the moment a project had more than a handful of declarations.
			const openByName = new Map<string, IndexedSymbol[]>();
			for (const entry of await this._openModelSymbols(languageId)) {
				const key = indexKeyOf(entry.symbol.name, languageId);
				const list = openByName.get(key);
				if (list) { list.push(entry); } else { openByName.set(key, [entry]); }
			}
			out.push(...collectMatches(index.symbols.byName, openByName, needle, MAX_SEARCH_RESULTS - out.length));
		}
		return out.slice(0, MAX_SEARCH_RESULTS);
	}

	/**
	 * Declarations of the files currently open in editors.
	 *
	 * The index reads the disk, so a method typed a second ago would otherwise be invisible exactly
	 * when it is needed most. Open buffers are therefore parsed live and win over the disk copy of
	 * the same file — including files with no unsaved changes, where both agree anyway.
	 *
	 * Cached by the model's version, so typing a line re-parses that one file once, not on every
	 * hover and every jump.
	 */
	private async _openModelSymbols(languageId: string): Promise<IndexedSymbol[]> {
		const out: IndexedSymbol[] = [];
		const seen = new Set<string>();
		for (const model of this._modelService.getModels()) {
			if (model.getLanguageId() !== languageId || model.isDisposed()) {
				continue;
			}
			const file = model.uri.toString();
			seen.add(file);
			const version = model.getVersionId();
			let cached = this._openModelCache.get(file);
			if (!cached || cached.version !== version) {
				cached = { version, symbols: await this.parseText(languageId, model.getValue()), languageId };
				this._openModelCache.set(file, cached);
			}
			for (const symbol of cached.symbols) {
				out.push({ symbol, file });
			}
		}
		// Closed editors must not keep answering: their file is back to being the disk's business.
		for (const file of [...this._openModelCache.keys()]) {
			if (!seen.has(file) && this._openModelCache.get(file)?.languageId === languageId) {
				this._openModelCache.delete(file);
			}
		}
		return out;
	}

	/**
	 * The user's own idea of what is not source: `files.exclude` and `search.exclude`.
	 *
	 * Read here so the index and «find all references» agree on what the project is. They did not
	 * before: the search service honours these settings, while the index only knew its own folder
	 * list — so a symbol could be indexed while its file was invisible to references, and the two
	 * features contradicted each other on the same repository.
	 */
	private _userExcludes(): glob.ParsedExpression | undefined {
		const expression = getExcludes(this._configuration.getValue<ISearchConfiguration>());
		return expression ? glob.parse(expression) : undefined;
	}

	private _limits(): { maxFiles: number; maxBytes: number; excluded: ReadonlySet<string> } {
		const maxFiles = this._configuration.getValue<number>(CONFIG_MAX_FILES);
		const maxFileKB = this._configuration.getValue<number>(CONFIG_MAX_FILE_KB);
		const excluded = this._configuration.getValue<unknown>(CONFIG_EXCLUDED_FOLDERS);
		return {
			maxFiles: typeof maxFiles === 'number' && maxFiles > 0 ? maxFiles : DEFAULT_MAX_FILES,
			maxBytes: (typeof maxFileKB === 'number' && maxFileKB > 0 ? maxFileKB : DEFAULT_MAX_FILE_KB) * 1024,
			excluded: new Set(Array.isArray(excluded) ? excluded.filter((name): name is string => typeof name === 'string') : DEFAULT_EXCLUDED_FOLDERS),
		};
	}

	private async _reindexFiles(languageId: string, index: LanguageIndex, resources: readonly URI[]): Promise<void> {
		for (const resource of resources) {
			const content = await this._fileService.readFile(resource).catch(() => undefined);
			// Unreadable now means gone or unreachable; dropping its symbols beats keeping stale ones.
			replaceFileSymbols(index.symbols, resource.toString(), content ? await this.parseText(languageId, content.value.toString()) : [], name => indexKeyOf(name, languageId));
		}
	}

	/**
	 * Build once per language, never on a caller's cancellation token.
	 *
	 * The editor cancels navigation requests freely — a keystroke, a second F12, a mouse move. If the
	 * scan died with the request, a large project could cancel every attempt just before it finished,
	 * and the feature would look permanently broken while working correctly.
	 */
	private async _ensureIndex(languageId: string, token: CancellationToken): Promise<LanguageIndex | undefined> {
		if (!this.isEnabled(languageId)) {
			return undefined;
		}
		const existing = this._indexes.get(languageId);
		if (existing) {
			return existing;
		}
		let building = this._building.get(languageId);
		if (!building) {
			// Shown in the status bar, not as a notification: the first jump in a large repository
			// waits for a walk of thousands of files, and silence there is indistinguishable from a
			// feature that does not work. A modal or a toast for something this routine would be worse
			// than the silence it replaces.
			building = this._progressService.withProgress(
				{ location: ProgressLocation.Window, title: localize('vibeide.codeNavigation.indexing', 'Собираю объявления: {0}', languageId) },
				() => this._build(languageId),
			).finally(() => this._building.delete(languageId));
			this._building.set(languageId, building);
		}
		await Promise.race([building, cancellationPromise(token)]);
		return this._indexes.get(languageId);
	}

	private async _build(languageId: string): Promise<void> {
		const started = Date.now();
		const token = this._scanCancellation.token;
		const { maxFiles, maxBytes, excluded } = this._limits();
		const userExcludes = this._userExcludes();
		try {
			const parser = await this._ensureParser(languageId);
			if (!parser) {
				return;
			}
			const index: LanguageIndex = { parser, symbols: createSymbolIndex() };
			const extensions = extensionsOf(languageId);
			let scanned = 0;

			/** Path relative to its workspace folder — what the exclude globs are written against. */
			const relativeTo = (folder: URI, resource: URI): string => {
				const prefix = folder.path.endsWith('/') ? folder.path : `${folder.path}/`;
				return resource.path.startsWith(prefix) ? resource.path.slice(prefix.length) : resource.path;
			};

			const walk = async (folder: URI, dir: URI): Promise<void> => {
				if (token.isCancellationRequested || scanned >= maxFiles) {
					return;
				}
				const entry = await this._fileService.resolve(dir).catch(() => undefined);
				for (const child of entry?.children ?? []) {
					if (token.isCancellationRequested || scanned >= maxFiles) {
						return;
					}
					const relative = relativeTo(folder, child.resource);
					if (child.isDirectory) {
						const skipped = child.name.startsWith('.') || excluded.has(child.name) || !!userExcludes?.(relative);
						if (!skipped) {
							await walk(folder, child.resource);
						}
						continue;
					}
					const lower = child.name.toLowerCase();
					if (!extensions.some(ext => lower.endsWith(ext)) || (child.size ?? 0) > maxBytes || userExcludes?.(relative)) {
						continue;
					}
					scanned++;
					// Yield regularly: indexing a large project must not freeze the window.
					if (scanned % 40 === 0) {
						await new Promise(resolve => setTimeout(resolve, 0));
					}
					const content = await this._fileService.readFile(child.resource).catch(() => undefined);
					if (content) {
						replaceFileSymbols(index.symbols, child.resource.toString(), parseWith(parser, languageId, content.value.toString()), name => indexKeyOf(name, languageId));
					}
				}
			};

			for (const folder of this._workspace.getWorkspace().folders) {
				await walk(folder.uri, folder.uri);
			}
			if (token.isCancellationRequested) {
				return;
			}
			this._indexes.set(languageId, index);
			if (scanned >= maxFiles) {
				// Not a warning the user can be expected to find in a log: the status command reports it,
				// because «не найдено» from a truncated index is a lie by omission.
				this._truncated.add(languageId);
				vibeLog.warn('codeIndex', `индекс ${languageId} НЕПОЛНЫЙ: достигнут предел ${maxFiles} файлов`);
			} else {
				this._truncated.delete(languageId);
			}
			vibeLog.debug('codeIndex', `индекс ${languageId}: ${index.symbols.byName.size} имён из ${scanned} файлов за ${Date.now() - started} мс`);
		} catch (err) {
			vibeLog.warn('codeIndex', `индекс ${languageId} построить не удалось: ${err}`);
		}
	}

	/** The parser is shared and outlives the index, so dropping an index frees no WASM memory. */
	private _disposeIndex(languageId: string): void {
		this._indexes.delete(languageId);
	}

	override dispose(): void {
		this._scanCancellation.cancel();
		this._indexes.clear();
		// Parsers hold WASM memory: without this they survive the window that created them.
		for (const parser of this._parsers.values()) {
			parser.delete();
		}
		this._parsers.clear();
		super.dispose();
	}
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

registerSingleton(IVibeCodeIndexService, VibeCodeIndexService, InstantiationType.Delayed);
