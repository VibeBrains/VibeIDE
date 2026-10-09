/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Calls of every project file, read with tree-sitter, for the project graph
 *
 * Its own index, not the navigation one: navigation is switched on per language by a setting and scans only when someone
 * goes to a definition, and TypeScript stays out of it on purpose — the language server answers there
 * The graph needs every language the project is written in, TypeScript first, and needs them when the graph is asked for
 *
 * Built on demand — the graph tab or the agent's report asks — and kept current after that: a changed file is re-read
 * alone, a full walk happens once. The file list is the repo index's, so both agree on what the project is
 */

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ITreeSitterLibraryService } from '../../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { CallFile } from '../../common/codeGraph/callResolution.js';
import { callGrammarOf, callLanguageOf, extractCalls } from '../../common/codeSymbols/callSites.js';
import { SyntaxNodeLike } from '../../common/codeSymbols/treeSitterSymbols.js';
import { vibeLog } from '../../common/vibeLog.js';
import { IRepoIndexerService } from '../repoIndexerService.js';

/** A file this large is a bundle or generated code: its calls describe the build, not the project */
const MAX_FILE_BYTES = 512 * 1024;
/** Files read from disk at once; parsing itself is one at a time — it is WebAssembly on this thread */
const READ_BATCH = 25;
/** Edits come in bursts; one re-read per burst */
const REFRESH_DELAY_MS = 2000;

export interface CallIndexState {
	readonly building: boolean;
	readonly parsed: number;
	readonly total: number;
}

export const IVibeCallIndexService = createDecorator<IVibeCallIndexService>('vibeCallIndexService');

export interface IVibeCallIndexService {
	readonly _serviceBrand: undefined;
	/** The set of read files changed; `version` moved */
	readonly onDidChange: Event<void>;
	/** Grows on every change — a consumer caches what it derived from `files()` by it */
	readonly version: number;
	readonly state: CallIndexState;
	/** Start reading, or finish what changed since; resolves when the files known now are read */
	ensureBuilt(): Promise<void>;
	files(): readonly CallFile[];
}

interface Parser {
	parse(text: string): { rootNode: unknown; delete(): void } | null;
	delete(): void;
}

class VibeCallIndexService extends Disposable implements IVibeCallIndexService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _files = new Map<string, CallFile>();
	private readonly _dirty = new Set<string>();
	private readonly _parsers = new Map<string, Promise<Parser | undefined>>();
	private readonly _refresh = this._register(new RunOnceScheduler(() => void this.ensureBuilt(), REFRESH_DELAY_MS));
	/** Nothing is read until someone asks: a project nobody draws should not pay for a walk */
	private _wanted = false;
	private _building: Promise<void> | undefined;
	private _version = 0;
	private _state: CallIndexState = { building: false, parsed: 0, total: 0 };

	constructor(
		@ITreeSitterLibraryService private readonly _treeSitter: ITreeSitterLibraryService,
		@IFileService private readonly _fileService: IFileService,
		@IRepoIndexerService private readonly _indexer: IRepoIndexerService,
	) {
		super();
		this._register(this._fileService.onDidFilesChange(e => {
			let touched = false;
			for (const resource of e.rawDeleted) {
				if (this._files.delete(resource.path)) {
					touched = true;
				}
			}
			for (const resource of [...e.rawAdded, ...e.rawUpdated]) {
				if (callLanguageOf(resource.path)) {
					this._dirty.add(resource.path);
				}
			}
			if (touched) {
				this._changed();
			}
			this._scheduleIfWanted();
		}));
		this._register(this._indexer.onDidChangeStructure(() => this._scheduleIfWanted()));
	}

	get version(): number {
		return this._version;
	}

	get state(): CallIndexState {
		return this._state;
	}

	files(): readonly CallFile[] {
		return [...this._files.values()];
	}

	ensureBuilt(): Promise<void> {
		this._wanted = true;
		this._building ??= this._build().finally(() => {
			this._building = undefined;
			if (this._dirty.size > 0) {
				this._refresh.schedule();
			}
		});
		return this._building;
	}

	private _scheduleIfWanted(): void {
		if (this._wanted) {
			this._refresh.schedule();
		}
	}

	private _changed(): void {
		this._version++;
		this._onDidChange.fire();
	}

	/** The repo index's file list, narrowed to what a grammar here reads */
	private _projectFiles(): string[] {
		return this._indexer.listStructure().map(entry => URI.parse(entry.uri).path).filter(path => !!callLanguageOf(path));
	}

	private async _build(): Promise<void> {
		const wanted = this._projectFiles();
		const present = new Set(wanted);
		let removed = false;
		for (const path of [...this._files.keys()]) {
			if (!present.has(path)) {
				this._files.delete(path);
				removed = true;
			}
		}
		const toRead = wanted.filter(path => !this._files.has(path) || this._dirty.has(path));
		for (const path of toRead) {
			this._dirty.delete(path);
		}
		if (toRead.length === 0) {
			if (removed) {
				this._changed();
			}
			return;
		}

		const started = Date.now();
		this._state = { building: true, parsed: 0, total: toRead.length };
		this._onDidChange.fire();
		try {
			for (let i = 0; i < toRead.length; i += READ_BATCH) {
				const batch = toRead.slice(i, i + READ_BATCH);
				const contents = await Promise.all(batch.map(async path => {
					try {
						const file = await this._fileService.readFile(URI.file(path), { limits: { size: MAX_FILE_BYTES } });
						return file.value.toString();
					} catch {
						return undefined; // too large, vanished or unreadable — it adds no calls
					}
				}));
				for (const [index, path] of batch.entries()) {
					const text = contents[index];
					const languageId = callLanguageOf(path)!;
					const parser = text === undefined ? undefined : await this._parserFor(languageId);
					const tree = parser?.parse(text!);
					if (!tree) {
						this._files.delete(path);
						continue;
					}
					try {
						this._files.set(path, { path, languageId, ...extractCalls(tree.rootNode as SyntaxNodeLike, languageId) });
					} finally {
						tree.delete(); // WASM memory is not reclaimed by the GC
					}
				}
				this._state = { building: true, parsed: Math.min(i + READ_BATCH, toRead.length), total: toRead.length };
				// Keeps the window answering while thousands of files go by
				await new Promise(resolve => setTimeout(resolve, 0));
			}
		} finally {
			this._state = { building: false, parsed: this._state.parsed, total: this._state.total };
			vibeLog.debug('callIndex', `вызовы прочитаны: ${toRead.length} файлов за ${Date.now() - started} мс`);
			this._changed();
		}
	}

	override dispose(): void {
		// Parsers live in WebAssembly memory, which the GC never sees
		for (const parser of this._parsers.values()) {
			void parser.then(loaded => loaded?.delete());
		}
		this._parsers.clear();
		super.dispose();
	}

	private _parserFor(languageId: string): Promise<Parser | undefined> {
		const grammar = callGrammarOf(languageId)!;
		let parser = this._parsers.get(grammar);
		if (!parser) {
			parser = (async () => {
				const [ParserClass, language] = await Promise.all([this._treeSitter.getParserClass(), this._treeSitter.getLanguagePromise(grammar)]);
				if (!language) {
					return undefined;
				}
				const created = new ParserClass();
				created.setLanguage(language);
				return created as unknown as Parser;
			})().catch(error => {
				vibeLog.warn('callIndex', `грамматика ${grammar} не загрузилась: ${error}`);
				return undefined;
			});
			this._parsers.set(grammar, parser);
		}
		return parser;
	}
}

registerSingleton(IVibeCallIndexService, VibeCallIndexService, InstantiationType.Delayed);
