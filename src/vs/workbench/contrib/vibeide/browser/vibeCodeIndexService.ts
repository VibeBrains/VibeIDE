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
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { CodeSymbol, extensionsOf, extractSymbols, grammarNameOf, symbolLanguageIds, SyntaxNodeLike } from '../common/codeSymbols/treeSitterSymbols.js';
import { createSymbolIndex, IndexedSymbol, preferOpenBuffers, replaceFileSymbols, SymbolIndex } from '../common/codeSymbols/codeIndexCore.js';
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

const DEFAULT_MAX_FILES = 4000;
const DEFAULT_MAX_FILE_KB = 1500;

/**
 * Folders that hold dependencies or build output in the supported languages. A default, not a law:
 * the setting exists because every monorepo draws this line somewhere else.
 */
const DEFAULT_EXCLUDED_FOLDERS = [
	'vendor', 'node_modules', 'storage', 'cache', 'var',
	'target', 'build', 'dist', 'bin', 'obj', '__pycache__', '.venv', 'venv',
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
	parseText(languageId: string, text: string): Promise<CodeSymbol[]>;
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

	constructor(
		@ITreeSitterLibraryService private readonly _treeSitter: ITreeSitterLibraryService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IModelService private readonly _modelService: IModelService,
	) {
		super();
		// Only the changed files are re-read. Dropping the whole index here would make every save
		// cost the next jump a full walk of the project, which is what this replaces.
		this._register(this._fileService.onDidFilesChange(e => {
			for (const [languageId, index] of this._indexes) {
				const extensions = extensionsOf(languageId);
				const matches = (resource: URI) => extensions.some(ext => resource.path.toLowerCase().endsWith(ext));
				for (const resource of e.rawDeleted.filter(matches)) {
					replaceFileSymbols(index.symbols, resource.toString(), []);
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

	isEnabled(languageId: string): boolean {
		const configured = this._configuration.getValue<unknown>(CONFIG_NAVIGATION_LANGUAGES);
		return Array.isArray(configured) ? configured.includes(languageId) : true;
	}

	async parseText(languageId: string, text: string): Promise<CodeSymbol[]> {
		const parser = await this._ensureParser(languageId);
		return parser ? parseWith(parser, languageId, text) : [];
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
		const fromDisk = index.symbols.byName.get(name) ?? [];
		const open = (await this._openModelSymbols(languageId)).filter(entry => entry.symbol.name === name);
		return preferOpenBuffers(fromDisk, open);
	}

	async search(query: string, token: CancellationToken): Promise<readonly IndexedSymbol[]> {
		const needle = query.trim().toLowerCase();
		const out: IndexedSymbol[] = [];
		for (const languageId of symbolLanguageIds()) {
			if (!this.isEnabled(languageId)) {
				continue;
			}
			// Only languages already indexed answer here: opening the symbol picker must not kick off
			// a scan of every language in the workspace at once.
			const index = this._indexes.get(languageId);
			if (!index || token.isCancellationRequested) {
				continue;
			}
			const open = await this._openModelSymbols(languageId);
			for (const [name, entries] of index.symbols.byName) {
				if (needle && !name.toLowerCase().includes(needle)) {
					continue;
				}
				out.push(...preferOpenBuffers(entries, open.filter(entry => entry.symbol.name === name)));
			}
			// Names that exist only in an open buffer — a declaration written but never yet saved.
			for (const entry of open) {
				if ((!needle || entry.symbol.name.toLowerCase().includes(needle)) && !index.symbols.byName.has(entry.symbol.name)) {
					out.push(entry);
				}
			}
		}
		return out;
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
			replaceFileSymbols(index.symbols, resource.toString(), content ? await this.parseText(languageId, content.value.toString()) : []);
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
			building = this._build(languageId).finally(() => this._building.delete(languageId));
			this._building.set(languageId, building);
		}
		await Promise.race([building, cancellationPromise(token)]);
		return this._indexes.get(languageId);
	}

	private async _build(languageId: string): Promise<void> {
		const started = Date.now();
		const token = this._scanCancellation.token;
		const { maxFiles, maxBytes, excluded } = this._limits();
		try {
			const parser = await this._ensureParser(languageId);
			if (!parser) {
				return;
			}
			const index: LanguageIndex = { parser, symbols: createSymbolIndex() };
			const extensions = extensionsOf(languageId);
			let scanned = 0;

			const walk = async (dir: URI): Promise<void> => {
				if (token.isCancellationRequested || scanned >= maxFiles) {
					return;
				}
				const entry = await this._fileService.resolve(dir).catch(() => undefined);
				for (const child of entry?.children ?? []) {
					if (token.isCancellationRequested || scanned >= maxFiles) {
						return;
					}
					if (child.isDirectory) {
						if (!child.name.startsWith('.') && !excluded.has(child.name)) {
							await walk(child.resource);
						}
						continue;
					}
					const lower = child.name.toLowerCase();
					if (!extensions.some(ext => lower.endsWith(ext)) || (child.size ?? 0) > maxBytes) {
						continue;
					}
					scanned++;
					// Yield regularly: indexing a large project must not freeze the window.
					if (scanned % 40 === 0) {
						await new Promise(resolve => setTimeout(resolve, 0));
					}
					const content = await this._fileService.readFile(child.resource).catch(() => undefined);
					if (content) {
						replaceFileSymbols(index.symbols, child.resource.toString(), parseWith(parser, languageId, content.value.toString()));
					}
				}
			};

			for (const folder of this._workspace.getWorkspace().folders) {
				await walk(folder.uri);
			}
			if (token.isCancellationRequested) {
				return;
			}
			this._indexes.set(languageId, index);
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
