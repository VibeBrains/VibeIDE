/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { vibeLog } from '../common/vibeLog.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { INDEX_SCOPE_VERSION, isIndexablePath } from '../common/indexScope.js';
import { IVibeEmbeddingsService } from '../common/embeddings/embeddingSource.js';
import { decodeVectorFile, encodeVectorFile, FileVectors, MAX_EMBEDDED_CHUNKS_PER_FILE, textsStamp, truncateVector, unitCosine } from '../common/embeddings/vectorFile.js';
import { fuseRankings } from '../common/embeddings/rankFusion.js';
import { createIgnoreMatcher, IgnoreMatcher } from '../common/vibeIgnore.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IContextGatheringService } from './contextGatheringService.js';
import { IFileService, FileChangesEvent } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { DocumentSymbol } from '../../../../editor/common/languages.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { LRUCache } from '../../../../base/common/map.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IVectorStore } from '../common/vectorStore.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { getPerformanceHarness } from '../common/performanceHarness.js';

interface IndexEntry {
	uri: string;
	symbols: string[];
	snippet: string; // First ~200 chars of file
	snippetStartLine?: number; // Line number where snippet starts (for citations)
	snippetEndLine?: number; // Line number where snippet ends
	chunks?: IndexChunk[]; // Multiple chunks with overlap for better retrieval
	// Pre-computed for faster queries
	snippetTokens?: Set<string>; // Tokenized snippet (lowercase)
	uriTokens?: Set<string>; // Tokenized URI path (lowercase)
	symbolTokens?: Set<string>; // All symbol tokens (lowercase)
	// Symbol relationships (imports/references)
	importedSymbols?: string[]; // Symbols imported from other files
	importedFrom?: string[]; // File paths imported from (relative paths)
}

interface IndexChunk {
	text: string;
	startLine: number;
	endLine: number;
	tokens?: Set<string>; // Pre-computed tokens for faster scoring
}

/**
 * On-disk (JSON) shapes of the index. Sets are serialized as arrays; all fields are optional
 * because the file is untrusted input and must be validated before use.
 */
interface SerializedIndexChunk {
	text?: string;
	startLine?: number;
	endLine?: number;
	tokens?: string[] | Set<string>;
}

interface SerializedIndexEntry {
	uri?: string;
	symbols?: string[];
	snippet?: string;
	snippetStartLine?: number;
	snippetEndLine?: number;
	chunks?: SerializedIndexChunk[];
	snippetTokens?: string[] | Set<string>;
	uriTokens?: string[] | Set<string>;
	symbolTokens?: string[] | Set<string>;
	importedSymbols?: string[];
	importedFrom?: string[];
}

/**
 * Narrows an untrusted JSON value to the serialized index array shape. Element-level validation
 * (required fields) is performed by the callers; this only confirms the top-level is an array.
 */
function isSerializedIndexArray(value: unknown): value is SerializedIndexEntry[] {
	return Array.isArray(value);
}

export interface QueryMetrics {
	retrievalLatencyMs: number;
	tokensInjected: number;
	resultsCount: number;
	topScore?: number;
	timedOut?: boolean;
	earlyTerminated?: boolean;
	embeddingLatencyMs?: number; // Time spent computing embeddings
	hybridSearchUsed?: boolean; // Whether hybrid (BM25 + vector) search was used
}

/**
 * What the index knows about one file, structurally. Deliberately narrow: consumers that need
 * structure (the code graph) get paths, symbol names and import specifiers — never the snippets,
 * chunks or embeddings, which exist only to serve similarity search.
 */
export interface RepoStructureEntry {
	readonly uri: string;
	readonly symbols: readonly string[];
	/** Import specifiers exactly as written in the source; bare packages included. */
	readonly importedFrom: readonly string[];
}

export interface IRepoIndexerService {
	readonly _serviceBrand: undefined;
	warmIndex(workspaceRoot?: URI): Promise<void>;
	query(text: string, k?: number): Promise<string[]>;
	queryWithMetrics(text: string, k?: number): Promise<{ results: string[]; metrics: QueryMetrics }>;
	rebuildIndex(): Promise<void>;
	/**
	 * Structural snapshot of the current index. Answers "what exists and what points where",
	 * as opposed to `query`, which answers "what looks relevant". Empty until the index is warm.
	 */
	listStructure(): readonly RepoStructureEntry[];
	/**
	 * The set of indexed files or what is known about them changed: the index was loaded, rebuilt, or files were updated
	 * A consumer drawing the structure refreshes on this instead of asking once and showing an empty picture forever
	 */
	readonly onDidChangeStructure: Event<void>;
	/** A full rebuild is running; an empty structure then means «ещё строится», not «пусто» */
	readonly isRebuilding: boolean;
	/** Search by meaning: the model of the vectors, files that have them, files in the index, and whether more are being made */
	vectorStatus(): { readonly modelId: string; readonly files: number; readonly total: number; readonly building: boolean };
}

export const IRepoIndexerService = createDecorator<IRepoIndexerService>('repoIndexerService');

class RepoIndexerService extends Disposable implements IRepoIndexerService {
	declare readonly _serviceBrand: undefined;

	private _index: IndexEntry[] = [];
	private _isWarmed = false;
	private _isRebuilding = false;
	/** The project's `.gitignore` and `.vibe/ignore`, read before every full walk and again when either changes */
	private _ignore: IgnoreMatcher | undefined;
	private _rebuildPromise: Promise<void> | undefined;
	private readonly _onDidChangeStructure = this._register(new Emitter<void>());
	readonly onDidChangeStructure = this._onDidChangeStructure.event;

	get isRebuilding(): boolean {
		return this._isRebuilding;
	}
	private _fileWatcher: IDisposable | undefined;
	private _pendingUpdates = new Set<string>(); // URIs that need indexing
	private _incrementalUpdateScheduler: RunOnceScheduler;
	private readonly _embeddingBackfill: RunOnceScheduler;
	private readonly _vectorSaveScheduler: RunOnceScheduler;
	private _saveIndexScheduler: RunOnceScheduler;

	// Inverted indexes for fast lookups
	private _termIndex: Map<string, Set<number>> = new Map(); // term -> set of entry indices
	private _symbolIndex: Map<string, Set<number>> = new Map(); // symbol name -> set of entry indices
	private _pathIndex: Map<string, number> = new Map(); // URI -> entry index

	// Query result cache (O(1) LRU cache for recent queries)
	private _queryCache: LRUCache<string, { results: string[]; metrics: QueryMetrics; timestamp: number }>;
	private static readonly QUERY_CACHE_SIZE = 200; // Cache last 200 queries (increased from 50)
	private static readonly QUERY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	// Query embedding cache (reuse embeddings for identical queries to avoid recomputation)
	private _queryEmbeddingCache: LRUCache<string, { embedding: number[]; timestamp: number }> = new LRUCache(50);
	private static readonly QUERY_EMBEDDING_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes (longer than query cache since embeddings are expensive)

	// Tokenization cache to avoid re-tokenizing same strings
	private _tokenizationCache: LRUCache<string, Set<string>> = new LRUCache(10000); // Increased from 1000 to 10000

	// File content cache for recently accessed files (avoids re-reading from disk)
	private _fileContentCache: LRUCache<string, string> = new LRUCache(500); // Increased from 100 to 500 files

	// BM25 statistics cache (pre-computed per document for faster scoring)
	private _bm25StatsCache: Map<number, {
		docLength: number;
		termFrequencies: Map<string, number>; // term -> frequency in this document
	}> = new Map();

	// Global average document length (cached, updated on index changes)
	private _cachedAvgDocLength: number = 0;
	private _avgDocLengthDirty = true;

	// Language-specific indexes for faster filtering
	private _languageIndex: Map<string, Set<number>> = new Map(); // file extension -> set of entry indices

	// Symbol relationship index: symbol name -> set of entry indices that import/use it
	private _symbolRelationshipIndex: Map<string, Set<number>> = new Map();

	// Path hierarchy index: directory path -> set of entry indices in that directory
	private _pathHierarchyIndex: Map<string, Set<number>> = new Map();

	// Common query patterns cache (pre-computed results for frequent queries)
	private _commonQueryCache: Map<string, number[]> = new Map(); // query pattern -> entry indices
	private static readonly COMMON_QUERY_PATTERNS = [
		'function', 'class', 'interface', 'type', 'const', 'let', 'var',
		'export', 'import', 'async', 'await', 'return', 'if', 'for', 'while'
	];

	// Performance monitoring (optimized with running average)
	private _recentLatencies: number[] = []; // Track last 10 query latencies
	private _runningSum = 0; // Running sum for O(1) average calculation
	private _isDisabledDueToPerformance = false;
	private static readonly MAX_LATENCY_HISTORY = 10;
	private static readonly PERFORMANCE_THRESHOLD_MS = 200; // Disable if average exceeds this
	private static readonly MIN_QUERIES_FOR_DISABLE = 5; // Need at least 5 queries before disabling

	// Debounce delay for incremental updates (3 seconds)
	private static readonly INCREMENTAL_UPDATE_DELAY = 3000;
	// Debounce delay for index saving (5 seconds)
	private static readonly SAVE_INDEX_DELAY = 5000;
	// Batch size for parallel file processing
	private static readonly BATCH_SIZE = 20;
	/** Index updates come in bursts; vectors are made once the burst is over */
	private static readonly EMBEDDING_BACKFILL_DELAY_MS = 3000;
	/** Files embedded between yields to the window and between saves of the vector file */
	private static readonly EMBEDDING_YIELD_FILES = 20;
	private static readonly EMBEDDING_SAVE_FILES = 200;
	/** Nearest fragments by meaning taken into a query, next to the ones found by words */
	private static readonly VECTOR_CANDIDATES = 30;
	// Query timeout (150ms - fast enough to not block, but allows good results)
	private static readonly QUERY_TIMEOUT_MS = 150;
	// Early termination threshold - stop scoring once we have this many high-scoring candidates
	private static readonly EARLY_TERMINATION_CANDIDATES = 50;

	// CPU throttling state
	private _cpuBudget: number = 0.2; // 20% of a core (configurable)
	private _lastCpuCheck: number = 0;
	private _cpuTimeUsed: number = 0;
	private _cpuCheckInterval: number = 100; // Check every 100ms

	/**
	 * Vectors of the index, per file, all made by `_vectorsModel`. Kept out of the index's JSON: sixty thousand fragments
	 * of 256 numbers are tens of megabytes as Float32 and hundreds as JSON text
	 */
	private readonly _vectors = new Map<string, FileVectors>();
	private _vectorsModel = '';
	private _vectorsLoadedFor = '';
	private _backfillRunning = false;
	/** Asked again while a run was going: the run that ends starts another, so late changes are not left waiting */
	private _backfillRequested = false;

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@IContextGatheringService private readonly contextGatheringService: IContextGatheringService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IModelService private readonly modelService: IModelService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IVectorStore private readonly vectorStore: IVectorStore,
		@IVibeideSettingsService private readonly settingsService: IVibeideSettingsService,
		@IVibeEmbeddingsService private readonly _embeddings: IVibeEmbeddingsService,
	) {
		super();
		// Initialize O(1) LRU cache
		this._queryCache = new LRUCache(RepoIndexerService.QUERY_CACHE_SIZE);

		// Vectors follow the source and the index: a new model, new files or changed files are embedded in the background
		this._embeddingBackfill = this._register(new RunOnceScheduler(() => void this._backfillVectors(), RepoIndexerService.EMBEDDING_BACKFILL_DELAY_MS));
		this._vectorSaveScheduler = this._register(new RunOnceScheduler(() => void this._saveVectors(), RepoIndexerService.SAVE_INDEX_DELAY));
		this._register(this._embeddings.onDidChangeState(() => this._embeddingBackfill.schedule()));
		this._register(this.onDidChangeStructure(() => this._embeddingBackfill.schedule()));
		// PERFORMANCE: Defer index loading until first use (lazy initialization)
		// This prevents blocking startup with synchronous file I/O
		// Index will be loaded on first query() or warmIndex() call
		// this._loadIndex(); // Removed - now lazy loaded

		// Setup incremental update scheduler
		this._incrementalUpdateScheduler = this._register(new RunOnceScheduler(
			() => this._processPendingUpdates(),
			RepoIndexerService.INCREMENTAL_UPDATE_DELAY
		));

		// Setup debounced index saving
		this._saveIndexScheduler = this._register(new RunOnceScheduler(
			() => this._saveIndex(),
			RepoIndexerService.SAVE_INDEX_DELAY
		));

		// Setup file watching after index is loaded (async)
		this._setupFileWatcher();

		// Initialize CPU budget from settings
		this._updateCpuBudget();

		// Listen for settings changes
		this._register(this.settingsService.onDidChangeState(() => {
			this._updateCpuBudget();
		}));
	}

	/**
	 * Update CPU budget from settings
	 */
	private _updateCpuBudget(): void {
		const perfSettings = this.settingsService.state.globalSettings.perf;
		this._cpuBudget = perfSettings?.indexerCpuBudget ?? 0.2; // Default 20% of a core
	}

	/**
	 * Throttle CPU usage to respect budget
	 * Yields to UI thread if CPU usage exceeds budget
	 */
	private async _throttleCpu(): Promise<void> {
		const now = performance.now();
		const elapsed = now - this._lastCpuCheck;

		if (elapsed >= this._cpuCheckInterval) {
			const cpuUsage = this._cpuTimeUsed / elapsed;
			if (cpuUsage > this._cpuBudget) {
				// CPU usage exceeds budget, yield to UI thread
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			this._cpuTimeUsed = 0;
			this._lastCpuCheck = now;
		}
	}

	private _getIndexPath(): URI | null {
		const workspace = this.workspaceContextService.getWorkspace();
		if (!workspace.id) { return null; }
		// Store index outside workspace in workspaceStorageHome, similar to how Cursor does it
		// This keeps the workspace clean and prevents index files from being visible to users
		return joinPath(this.environmentService.workspaceStorageHome, workspace.id, 'codebase-index.json');
	}

	/** Which scope rule built the saved index; see `INDEX_SCOPE_VERSION` */
	private _getScopeMarkerPath(): URI | null {
		const workspace = this.workspaceContextService.getWorkspace();
		return workspace.id ? joinPath(this.environmentService.workspaceStorageHome, workspace.id, 'codebase-index.scope') : null;
	}

	private async _isBuiltUnderCurrentScope(): Promise<boolean> {
		const marker = this._getScopeMarkerPath();
		if (!marker) {
			return true;
		}
		try {
			return (await this.fileService.readFile(marker)).value.toString().trim() === INDEX_SCOPE_VERSION;
		} catch {
			return false;
		}
	}

	private async _markScope(): Promise<void> {
		const marker = this._getScopeMarkerPath();
		if (marker) {
			await this.fileService.writeFile(marker, VSBuffer.fromString(INDEX_SCOPE_VERSION)).catch(() => undefined);
		}
	}

	private async _loadIndex(): Promise<void> {
		const indexPath = this._getIndexPath();
		if (!indexPath) { return; }
		try {
			const content = await this.fileService.readFile(indexPath);
			const data: unknown = JSON.parse(content.value.toString());
			if (isSerializedIndexArray(data)) {
				// PERFORMANCE: Process entries in chunks to avoid blocking UI for large indexes
				// Chunk size: 1000 entries per chunk (yield to UI thread between chunks)
				const CHUNK_SIZE = 1000;
				const filteredData = data.filter(entry =>
					entry &&
					typeof entry.uri === 'string' &&
					Array.isArray(entry.symbols) &&
					typeof entry.snippet === 'string'
				);

				this._index = [];
				for (let i = 0; i < filteredData.length; i += CHUNK_SIZE) {
					const chunk = filteredData.slice(i, i + CHUNK_SIZE);
					const processedChunk = chunk.map((entry): IndexEntry => ({
						...entry,
						// Required fields — validated by the filter above
						uri: entry.uri!,
						symbols: entry.symbols!,
						snippet: entry.snippet!,
						// Convert arrays back to Sets for fast lookups
						snippetTokens: entry.snippetTokens ? new Set(entry.snippetTokens) : undefined,
						uriTokens: entry.uriTokens ? new Set(entry.uriTokens) : undefined,
						symbolTokens: entry.symbolTokens ? new Set(entry.symbolTokens) : undefined,
						chunks: entry.chunks?.map((chunk): IndexChunk => ({
							...chunk,
							text: chunk.text!,
							startLine: chunk.startLine!,
							endLine: chunk.endLine!,
							tokens: chunk.tokens ? new Set(chunk.tokens) : undefined,
						})),
						// Import information is already arrays, no conversion needed
						importedSymbols: entry.importedSymbols,
						importedFrom: entry.importedFrom
					}));
					this._index.push(...processedChunk);

					// Yield to UI thread between chunks for large indexes
					if (i + CHUNK_SIZE < filteredData.length) {
						await new Promise(resolve => setTimeout(resolve, 0));
					}
				}

				// Rebuild inverted indexes from loaded data (tokens already pre-computed!)
				this._rebuildInvertedIndexes();
				this._isWarmed = true;
				this._onDidChangeStructure.fire();
			}
		} catch (error) {
			// Try to migrate from old location (.vibeide/index.json in workspace)
			await this._tryMigrateFromOldLocation();
		}
	}

	private async _tryMigrateFromOldLocation(): Promise<void> {
		const workspace = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!workspace) { return; }

		const oldIndexPath = workspace.with({ path: `${workspace.path}/.vibeide/index.json` });
		try {
			const content = await this.fileService.readFile(oldIndexPath);
			const data: unknown = JSON.parse(content.value.toString());
			if (isSerializedIndexArray(data)) {
				// Validate and migrate index entries (convert arrays to Sets if present)
				this._index = data.filter(entry =>
					entry &&
					typeof entry.uri === 'string' &&
					Array.isArray(entry.symbols) &&
					typeof entry.snippet === 'string'
				).map((entry): IndexEntry => ({
					...entry,
					// Required fields — validated by the filter above
					uri: entry.uri!,
					symbols: entry.symbols!,
					snippet: entry.snippet!,
					snippetTokens: entry.snippetTokens ? (Array.isArray(entry.snippetTokens) ? new Set(entry.snippetTokens) : entry.snippetTokens) : undefined,
					uriTokens: entry.uriTokens ? (Array.isArray(entry.uriTokens) ? new Set(entry.uriTokens) : entry.uriTokens) : undefined,
					symbolTokens: entry.symbolTokens ? (Array.isArray(entry.symbolTokens) ? new Set(entry.symbolTokens) : entry.symbolTokens) : undefined,
					chunks: entry.chunks?.map((chunk): IndexChunk => ({
						...chunk,
						text: chunk.text!,
						startLine: chunk.startLine!,
						endLine: chunk.endLine!,
						tokens: chunk.tokens ? (Array.isArray(chunk.tokens) ? new Set(chunk.tokens) : chunk.tokens) : undefined
					})),
					// Import information is already arrays, no conversion needed
					importedSymbols: entry.importedSymbols,
					importedFrom: entry.importedFrom
				}));
				// Rebuild inverted indexes from migrated data
				this._rebuildInvertedIndexes();
				this._isWarmed = true;
				this._onDidChangeStructure.fire();
				// Save to new location
				await this._saveIndex();
				vibeLog.debug('repoIndexer', '[RepoIndexer] Migrated index from old location to new location');
			}
		} catch (error) {
			// Old index doesn't exist or is invalid, will rebuild on demand
			vibeLog.debug('repoIndexer', '[RepoIndexer] Failed to load index, will rebuild:', error);
		}
	}

	private async _saveIndex(): Promise<void> {
		const indexPath = this._getIndexPath();
		if (!indexPath) { return; }
		try {
			// Serialize with Set conversion for JSON compatibility
			// Optimize: remove undefined/null fields and use compact format
			const serializableIndex = this._index.map(entry => {
				const result: SerializedIndexEntry = {
					uri: entry.uri,
					symbols: entry.symbols,
					snippet: entry.snippet
				};
				// Only include optional fields if they exist
				if (entry.snippetStartLine) { result.snippetStartLine = entry.snippetStartLine; }
				if (entry.snippetEndLine) { result.snippetEndLine = entry.snippetEndLine; }
				if (entry.snippetTokens && entry.snippetTokens.size > 0) {
					result.snippetTokens = Array.from(entry.snippetTokens);
				}
				if (entry.uriTokens && entry.uriTokens.size > 0) {
					result.uriTokens = Array.from(entry.uriTokens);
				}
				if (entry.symbolTokens && entry.symbolTokens.size > 0) {
					result.symbolTokens = Array.from(entry.symbolTokens);
				}
				if (entry.chunks && entry.chunks.length > 0) {
					result.chunks = entry.chunks.map(chunk => {
						const chunkResult: SerializedIndexChunk = {
							text: chunk.text,
							startLine: chunk.startLine,
							endLine: chunk.endLine
						};
						if (chunk.tokens && chunk.tokens.size > 0) {
							chunkResult.tokens = Array.from(chunk.tokens);
						}
						return chunkResult;
					});
				}
				// Include import information if available
				if (entry.importedSymbols && entry.importedSymbols.length > 0) {
					result.importedSymbols = entry.importedSymbols;
				}
				if (entry.importedFrom && entry.importedFrom.length > 0) {
					result.importedFrom = entry.importedFrom;
				}
				return result;
			});

			// Use compact JSON (no pretty printing) for smaller file size
			const content = JSON.stringify(serializableIndex);
			const bufferModule = await import('../../../../base/common/buffer.js');
			// Ensure parent folder exists
			const parentPath = indexPath.with({ path: indexPath.path.replace(/\/[^/]*$/, '') });
			try {
				await this.fileService.createFolder(parentPath);
			} catch {
				// Folder might already exist, ignore
			}
			await this.fileService.writeFile(indexPath, bufferModule.VSBuffer.fromString(content));
		} catch (e) {
			vibeLog.warn('repoIndexer', '[RepoIndexer] Failed to save repo index:', e);
		}
	}

	/** Files the project itself keeps out of version control are not its code: read them before deciding what to index */
	private async _loadIgnore(workspaceRoot: URI): Promise<void> {
		const parts: string[] = [];
		for (const name of [['.gitignore'], ['.vibe', 'ignore']]) {
			try {
				parts.push((await this.fileService.readFile(joinPath(workspaceRoot, ...name))).value.toString());
			} catch {
				// No such file — the project simply has no rules of that kind
			}
		}
		this._ignore = parts.length > 0 ? createIgnoreMatcher(parts.join('\n')) : undefined;
	}

	/** The one rule for the walk and for file-change events, measured from the project root */
	private _isIndexable(workspaceRoot: URI, resource: URI, isDirectory: boolean): boolean {
		const root = workspaceRoot.path.endsWith('/') ? workspaceRoot.path : `${workspaceRoot.path}/`;
		if (!resource.path.startsWith(root)) {
			return false;
		}
		return isIndexablePath(resource.path.slice(root.length), isDirectory, this._ignore);
	}

	private async _walkFiles(workspaceRoot: URI, onFile: (uri: URI) => Promise<void>, token: CancellationToken = CancellationToken.None): Promise<void> {
		await this._loadIgnore(workspaceRoot);

		// PERFORMANCE: Track directory count for cooperative yielding
		let directoryCount = 0;
		const YIELD_INTERVAL = 50; // Yield every 50 directories to maintain UI responsiveness

		const walk = async (dir: URI): Promise<void> => {
			// Check cancellation token
			if (token.isCancellationRequested) {
				return;
			}

			try {
				const entries = await this.fileService.resolve(dir);
				if (!entries.children) { return; }

				// PERFORMANCE: Yield to event loop periodically to avoid blocking UI
				directoryCount++;
				if (directoryCount % YIELD_INTERVAL === 0) {
					await new Promise(resolve => setTimeout(resolve, 0));
					// Check cancellation again after yielding
					if (token.isCancellationRequested) {
						return;
					}
				}

				for (const child of entries.children) {
					// Check cancellation before processing each child
					if (token.isCancellationRequested) {
						return;
					}

					if (child.isDirectory) {
						if (this._isIndexable(workspaceRoot, child.resource, true)) {
							await walk(child.resource);
						}
					} else if (child.isFile && this._isIndexable(workspaceRoot, child.resource, false)) {
						await onFile(child.resource);
					}
				}
			} catch {
				// Ignore errors (permissions, etc.)
			}
		};

		await walk(workspaceRoot);
	}

	private async _extractSymbols(uri: URI): Promise<string[]> {
		const symbols: string[] = [];

		try {
			// Only extract symbols if model is already loaded (to avoid expensive model initialization)
			// During rebuild, symbols will only be extracted for files that are already open/loaded
			const model = this.modelService.getModel(uri);
			if (!model) { return symbols; }

			const docSymbols = await this.languageFeaturesService.documentSymbolProvider.ordered(model);
			if (!docSymbols || docSymbols.length === 0) { return symbols; }

			for (const provider of docSymbols) {
				const docSymbols_ = await provider.provideDocumentSymbols(model, CancellationToken.None);
				if (docSymbols_) {
					const extract = (sym: DocumentSymbol): void => {
						const name = sym.name || '';
						if (name && !symbols.includes(name)) {
							symbols.push(name);
						}
						if (sym.children) {
							for (const child of sym.children) { extract(child); }
						}
					};
					for (const sym of docSymbols_) {
						extract(sym);
					}
				}
			}
		} catch {
			// Ignore symbol extraction errors
		}
		return symbols;
	}

	/**
	 * Extract import statements from file content (simple regex-based approach)
	 * Returns: { importedSymbols: string[], importedFrom: string[] }
	 */
	private _extractImports(text: string): { importedSymbols: string[]; importedFrom: string[] } {
		const importedSymbols: string[] = [];
		const importedFrom: string[] = [];

		try {
			// Match ES6/TypeScript import patterns:
			// import { a, b, c } from './path'
			// import * as name from './path'
			// import defaultName from './path'
			// import './path'
			const importRegex = /import\s+(?:(?:\*\s+as\s+(\w+))|(?:\{([^}]+)\})|(\w+)|['"])\s+from\s+['"]([^'"]+)['"]/g;
			let match;
			importRegex.lastIndex = 0; // Reset regex lastIndex to prevent bugs
			while ((match = importRegex.exec(text)) !== null) {
				const namespaceImport = match[1];
				const namedImports = match[2];
				const defaultImport = match[3];
				const importPath = match[4];

				if (importPath && !importPath.startsWith('http') && !importPath.startsWith('node:')) {
					importedFrom.push(importPath);
				}

				if (namespaceImport) {
					importedSymbols.push(namespaceImport);
				}
				if (defaultImport) {
					importedSymbols.push(defaultImport);
				}
				if (namedImports) {
					// Extract individual named imports
					const names = namedImports.split(',').map(n => {
						// Handle "name as alias" pattern
						const parts = n.trim().split(/\s+as\s+/);
						return parts[parts.length - 1].trim();
					}).filter(Boolean);
					importedSymbols.push(...names);
				}
			}

			// Match require() patterns: const x = require('./path')
			const requireRegex = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
			requireRegex.lastIndex = 0; // Reset regex lastIndex to prevent bugs
			while ((match = requireRegex.exec(text)) !== null) {
				const varName = match[1];
				const requirePath = match[2];
				if (varName) {
					importedSymbols.push(varName);
				}
				if (requirePath && !requirePath.startsWith('http') && !requirePath.startsWith('node:')) {
					importedFrom.push(requirePath);
				}
			}
		} catch {
			// Ignore import extraction errors
		}

		return { importedSymbols, importedFrom };
	}

	private async _extractSnippet(uri: URI): Promise<{ snippet: string; startLine: number; endLine: number; chunks?: IndexChunk[] }> {
		try {
			// Check file content cache first
			const uriPath = uri.fsPath;
			let text: string;
			const cachedContent = this._fileContentCache.get(uriPath);
			if (cachedContent) {
				text = cachedContent;
			} else {
				const content = await this.fileService.readFile(uri);
				text = content.value.toString();
				// Cache file content for future use
				this._fileContentCache.set(uriPath, text);
			}

			const base = uri.path.split('/').pop()?.toLowerCase();
			const lines = text.split('\n');

			// For overview docs, use longer initial snippet
			const isOverviewDoc = base === 'readme.md' || base === 'package.json' || base === 'product.json';
			const initialLimit = isOverviewDoc ? 800 : 400;
			const chunkSize = isOverviewDoc ? 600 : 400; // Chunk size in characters
			const chunkOverlap = 100; // Overlap between chunks
			const maxChunks = isOverviewDoc ? 3 : 5; // More chunks for regular files

			// Calculate first snippet (backward compatible)
			let charCount = 0;
			let endLine = 1;
			for (let i = 0; i < lines.length; i++) {
				charCount += lines[i].length + 1;
				if (charCount > initialLimit) {
					endLine = i + 1;
					break;
				}
				endLine = i + 1;
			}
			const snippetText = lines.slice(0, endLine).join('\n').slice(0, initialLimit).replace(/\n$/, '');

			// Generate chunks using character-based chunking
			const chunks: IndexChunk[] = [];
			let currentPos = 0;
			let chunkIndex = 0;

			while (currentPos < text.length && chunkIndex < maxChunks) {
				let chunkEndPos = currentPos + chunkSize;
				if (chunkEndPos > text.length) {
					chunkEndPos = text.length;
				}

				// Find line boundaries - calculate accurately
				const chunkText = text.slice(currentPos, chunkEndPos);
				const beforeText = text.slice(0, currentPos);

				// Calculate line numbers: count newlines before start position
				// If beforeText is empty, we're on line 1
				// If beforeText has n newlines, we're on line n+1
				const startLineNum = beforeText === '' ? 1 : beforeText.split('\n').length;
				const endLineNum = text.slice(0, chunkEndPos).split('\n').length;

				if (chunkText.trim().length > 50) { // Only add non-trivial chunks
					const trimmedChunk = chunkText.trim();
					// Always pre-compute tokens during indexing (not lazy)
					const chunkTokens = this._tokenize(trimmedChunk);
					chunks.push({
						text: trimmedChunk,
						startLine: startLineNum,
						endLine: endLineNum,
						tokens: chunkTokens // Pre-computed tokens for faster scoring
					});
				}

				currentPos += chunkSize - chunkOverlap;
				chunkIndex++;

				if (chunkEndPos >= text.length) { break; }
			}

			// If no chunks generated, use first snippet as single chunk
			if (chunks.length === 0) {
				chunks.push({
					text: snippetText,
					startLine: 1,
					endLine: endLine,
					tokens: this._tokenize(snippetText) // Pre-compute tokens
				});
			}

			return { snippet: snippetText, startLine: 1, endLine, chunks };
		} catch {
			return { snippet: '', startLine: 1, endLine: 1, chunks: [] };
		}
	}

	private _vectorsPath(): URI | null {
		const workspace = this.workspaceContextService.getWorkspace();
		return workspace.id ? joinPath(this.environmentService.workspaceStorageHome, workspace.id, 'codebase-index.vectors') : null;
	}

	private async _loadVectors(modelId: string): Promise<void> {
		const path = this._vectorsPath();
		if (!path) {
			return;
		}
		try {
			const file = decodeVectorFile((await this.fileService.readFile(path)).value.buffer);
			// Vectors of another model are not comparable; they are dropped and made again
			if (file && file.modelId === modelId) {
				for (const [uri, vectors] of file.files) {
					this._vectors.set(uri, vectors);
				}
			}
		} catch {
			// No vector file yet — the backfill makes one
		}
	}

	private async _saveVectors(): Promise<void> {
		const path = this._vectorsPath();
		if (!path || !this._vectorsModel) {
			return;
		}
		const bytes = encodeVectorFile({ modelId: this._vectorsModel, dims: [...this._vectors.values()][0]?.vectors[0]?.length ?? 0, files: this._vectors });
		await this.fileService.writeFile(path, VSBuffer.wrap(bytes)).catch(error => vibeLog.warn('repoIndexer', `векторы не сохранились: ${error}`));
	}

	/** Texts a file is embedded by: its first fragments, or its snippet when it has none */
	private _embeddingTexts(entry: IndexEntry): string[] {
		const chunks = entry.chunks ?? [];
		return chunks.length > 0 ? chunks.slice(0, MAX_EMBEDDED_CHUNKS_PER_FILE).map(chunk => chunk.text) : [entry.snippet];
	}

	/**
	 * Make the vectors the index is missing: every file on a new model, new and changed files after that
	 * Runs in the background, a file at a time with yields, and stops as soon as the source changes under it
	 */
	private async _backfillVectors(): Promise<void> {
		const state = this._embeddings.state;
		if (this._backfillRunning) {
			this._backfillRequested = true;
			return;
		}
		if (!state.ready || this._isRebuilding) {
			return;
		}
		this._backfillRunning = true;
		const model = state.modelId;
		try {
			if (this._vectorsModel !== model) {
				this._vectors.clear();
				this._vectorsModel = model;
			}
			if (this._vectorsLoadedFor !== model) {
				this._vectorsLoadedFor = model;
				await this._loadVectors(model);
			}
			const present = new Set(this._index.map(entry => entry.uri));
			for (const uri of [...this._vectors.keys()]) {
				if (!present.has(uri)) {
					this._vectors.delete(uri);
				}
			}
			const todo = this._index.filter(entry => this._vectors.get(entry.uri)?.stamp !== textsStamp(this._embeddingTexts(entry)));
			let made = 0;
			for (const entry of todo) {
				if (this._embeddings.state.modelId !== model || !this._embeddings.state.ready) {
					return; // the source changed: the next run starts over with it
				}
				const texts = this._embeddingTexts(entry);
				const vectors = await this._computeEmbeddings(texts, CancellationToken.None);
				if (vectors.length === texts.length) {
					this._vectors.set(entry.uri, { stamp: textsStamp(texts), vectors: vectors.map(vector => truncateVector(vector)) });
				}
				made++;
				if (made % RepoIndexerService.EMBEDDING_YIELD_FILES === 0) {
					await new Promise(resolve => setTimeout(resolve, 0));
				}
				if (made % RepoIndexerService.EMBEDDING_SAVE_FILES === 0) {
					this._vectorSaveScheduler.schedule();
				}
			}
			if (made > 0) {
				this._queryCache.clear();
				this._vectorSaveScheduler.schedule();
				vibeLog.info('repoIndexer', `векторы ${model}: ${this._vectors.size} файлов, новых ${made}`);
			}
		} finally {
			this._backfillRunning = false;
			if (this._backfillRequested) {
				this._backfillRequested = false;
				this._embeddingBackfill.schedule();
			}
		}
	}

	vectorStatus(): { readonly modelId: string; readonly files: number; readonly total: number; readonly building: boolean } {
		return { modelId: this._vectorsModel, files: this._vectors.size, total: this._index.length, building: this._backfillRunning };
	}

	/** Fragments nearest to the query by meaning, across the whole index; one per file, the best of its fragments */
	private _vectorCandidates(query: Float32Array, limit: number): Array<{ entry: IndexEntry; chunk?: IndexChunk; score: number; isChunk: boolean }> {
		const scored: Array<{ entry: IndexEntry; chunk?: IndexChunk; score: number; isChunk: boolean }> = [];
		for (const [uri, file] of this._vectors) {
			const position = this._pathIndex.get(uri.toLowerCase());
			const entry = position === undefined ? undefined : this._index[position];
			if (!entry) {
				continue;
			}
			let best = -1;
			let bestAt = 0;
			file.vectors.forEach((vector, index) => {
				const score = unitCosine(query, vector);
				if (score > best) {
					best = score;
					bestAt = index;
				}
			});
			const chunk = entry.chunks?.[bestAt];
			scored.push({ entry, chunk, score: best, isChunk: !!chunk });
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/**
	 * One rebuild at a time: the graph tab warms the index on open and on «Обновить», and a second walk over the same
	 * repository in parallel would only race the first for `_index`
	 */
	rebuildIndex(token: CancellationToken = CancellationToken.None): Promise<void> {
		if (!this._rebuildPromise) {
			this._isRebuilding = true;
			this._onDidChangeStructure.fire();
			this._rebuildPromise = this._rebuildIndexOnce(token).finally(() => {
				this._isRebuilding = false;
				this._rebuildPromise = undefined;
				this._onDidChangeStructure.fire();
			});
		}
		return this._rebuildPromise;
	}

	private async _rebuildIndexOnce(token: CancellationToken): Promise<void> {
		const workspace = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!workspace) {
			this.notificationService.warn('No workspace open. Cannot rebuild index.');
			return;
		}

		this.notificationService.info('Rebuilding repo index...');
		this._index = [];

		// Reset performance tracking, inverted indexes, and query cache on rebuild
		this._recentLatencies = [];
		this._runningSum = 0;
		this._isDisabledDueToPerformance = false;
		this._termIndex.clear();
		this._symbolIndex.clear();
		this._pathIndex.clear();
		this._languageIndex.clear();
		this._symbolRelationshipIndex.clear();
		this._pathHierarchyIndex.clear();
		this._queryCache.clear(); // Clear cache since index changed
		this._commonQueryCache.clear(); // Clear common query cache
		this._tokenizationCache.clear(); // Clear tokenization cache too
		this._fileContentCache.clear(); // Clear file content cache
		this._bm25StatsCache.clear(); // Clear BM25 stats cache
		this._avgDocLengthDirty = true; // Mark average doc length as dirty

		// Collect all files first (with cancellation support)
		const filesToIndex: URI[] = [];
		await this._walkFiles(workspace, async (uri) => {
			if (token.isCancellationRequested) {
				return;
			}
			filesToIndex.push(uri);
		}, token);

		// Check cancellation after file walking
		if (token.isCancellationRequested) {
			this.notificationService.info('Index rebuild cancelled.');
			return;
		}

		// Process files in parallel batches for better performance
		let fileCount = 0;
		let failedCount = 0;

		for (let i = 0; i < filesToIndex.length; i += RepoIndexerService.BATCH_SIZE) {
			// Check cancellation before processing each batch
			if (token.isCancellationRequested) {
				this.notificationService.info(`Index rebuild cancelled. Indexed ${fileCount} files so far.`);
				return;
			}

			const batch = filesToIndex.slice(i, i + RepoIndexerService.BATCH_SIZE);

			const results = await Promise.allSettled(
				batch.map(async (uri): Promise<IndexEntry> => {
					// Check cancellation before processing each file
					if (token.isCancellationRequested) {
						throw new Error('Cancelled');
					}

					try {
						// Extract symbols (will only work for files with loaded models)
						const symbols = await this._extractSymbols(uri);
						const snippetResult = await this._extractSnippet(uri);
						const { snippet, startLine, endLine, chunks } = snippetResult;

						// Extract imports from file content
						const fileContent = this._fileContentCache.get(uri.fsPath) ||
							(await this.fileService.readFile(uri)).value.toString();
						const { importedSymbols, importedFrom } = this._extractImports(fileContent);

						return {
							uri: uri.fsPath,
							symbols,
							snippet,
							snippetStartLine: startLine,
							snippetEndLine: endLine,
							chunks: chunks,
							importedSymbols: importedSymbols.length > 0 ? importedSymbols : undefined,
							importedFrom: importedFrom.length > 0 ? importedFrom : undefined
						};
					} catch (error) {
						failedCount++;
						throw error;
					}
				})
			);

			// Add successful results to index and update inverted indexes
			for (const result of results) {
				if (result.status === 'fulfilled') {
					const entryIndex = this._index.length;
					this._index.push(result.value);
					this._updateInvertedIndexesForEntry(result.value, entryIndex);
					fileCount++;
				}
			}

			// PERFORMANCE: Yield to event loop periodically to avoid blocking UI
			// This maintains responsiveness during long indexing operations
			if (i + RepoIndexerService.BATCH_SIZE < filesToIndex.length) {
				await new Promise(resolve => setTimeout(resolve, 0));
			}
		}

		await this._saveIndex();
		await this._markScope();
		this._isWarmed = true;
		this.notificationService.info(`Repo index rebuilt: ${fileCount} files indexed${failedCount > 0 ? `, ${failedCount} failed` : ''}.`);

		// Re-setup file watcher after rebuild
		this._setupFileWatcher();
	}

	async warmIndex(workspaceRoot?: URI): Promise<void> {
		if (this._isWarmed) { return; }

		const workspace = this.workspaceContextService.getWorkspace();
		if (!workspace.id) {
			// Fallback to context cache if no workspace ID
			const seed = this.contextGatheringService.getCachedSnippets();
			if (seed.length > 0) {
				this._isWarmed = true;
			}
			return;
		}

		// Try to load existing index
		await this._loadIndex();

		if (this._index.length === 0) {
			// No index found: cached snippets can warm the search right away, but they are not an index,
			// And the code graph reads the index alone. Marking warm without a rebuild left the graph empty for good
			const seed = this.contextGatheringService.getCachedSnippets();
			if (seed.length > 0) {
				this._isWarmed = true;
			}
			// Trigger background rebuild (non-blocking)
			this.rebuildIndex().catch(() => { });
		} else {
			this._isWarmed = true;
			// An index saved under an older scope rule still answers now, and is replaced by one rebuild in the background
			if (!(await this._isBuiltUnderCurrentScope())) {
				this.rebuildIndex().catch(() => { });
			}
		}

		// Ensure file watcher is set up after warmup
		this._setupFileWatcher();
	}

	async query(text: string, k: number = 5): Promise<string[]> {
		const result = await this.queryWithMetrics(text, k);
		return result.results;
	}

	listStructure(): readonly RepoStructureEntry[] {
		// Copied out rather than handed over: the index is mutated in place by incremental updates,
		// and a consumer holding live references would see it change under itself mid-traversal.
		return this._index.map(entry => ({
			uri: entry.uri,
			symbols: [...entry.symbols],
			importedFrom: [...(entry.importedFrom ?? [])],
		}));
	}

	async queryWithMetrics(text: string, k: number = 5): Promise<{ results: string[]; metrics: QueryMetrics }> {
		// PERFORMANCE: Lazy load index on first query if not already loaded
		if (!this._isWarmed && this._index.length === 0) {
			await this._loadIndex();
		}

		const startTime = performance.now();
		let embeddingLatencyMs = 0;
		let queryEmbedding: number[] | undefined;

		// Check query cache first (normalize query for cache key)
		// The model is part of the key: the same words find other files once vectors exist or the model changes
		const cacheKey = `${this._vectorsModel}:${this._vectors.size}:${text.toLowerCase().trim()}:${k}`;
		const cached = this._queryCache.get(cacheKey);
		if (cached && (performance.now() - cached.timestamp) < RepoIndexerService.QUERY_CACHE_TTL_MS) {
			// Return cached result with updated timestamp (LRU cache auto-updates access time)
			cached.timestamp = performance.now();
			return { results: cached.results, metrics: cached.metrics };
		}

		// Compute query embedding if available (for hybrid search)
		// PERFORMANCE: Reuse cached embeddings for identical queries (expensive operation)
		if (this._canComputeEmbeddings() && this._vectors.size > 0 && this._vectorsModel === this._embeddings.state.modelId) {
			try {
				// Check embedding cache first (normalize query for cache key)
				const embeddingCacheKey = `${this._embeddings.state.modelId}:${text.toLowerCase().trim()}`;
				const cachedEmbedding = this._queryEmbeddingCache.get(embeddingCacheKey);
				if (cachedEmbedding && (performance.now() - cachedEmbedding.timestamp) < RepoIndexerService.QUERY_EMBEDDING_CACHE_TTL_MS) {
					queryEmbedding = cachedEmbedding.embedding;
					embeddingLatencyMs = 0; // Cache hit - no latency
				} else {
					// Cache miss - compute embedding
					const embeddingStartTime = performance.now();
					const embeddings = await this._computeEmbeddings([text], CancellationToken.None);
					embeddingLatencyMs = performance.now() - embeddingStartTime;
					// _computeEmbeddings always returns number[][], so take first element
					if (embeddings.length > 0 && embeddings[0] && embeddings[0].length > 0) {
						queryEmbedding = embeddings[0];
						// Cache the embedding for future queries
						this._queryEmbeddingCache.set(embeddingCacheKey, {
							embedding: queryEmbedding,
							timestamp: performance.now()
						});
					}
				}
			} catch (error) {
				// Embedding computation failed, continue with BM25-only
				vibeLog.debug('repoIndexer', '[RepoIndexer] Query embedding computation failed:', error);
			}
		}

		// Try vector store query if enabled (for hybrid search)
		let vectorResults: Array<{ id: string; score: number }> = [];
		if (this.vectorStore.isEnabled() && queryEmbedding) {
			try {
				const vectorStoreResults = await this.vectorStore.query(queryEmbedding, k * 2); // Get more candidates for reranking
				vectorResults = vectorStoreResults.map(r => ({ id: r.id, score: r.score }));
			} catch (error) {
				// Vector store query failed, continue with BM25-only
				vibeLog.debug('repoIndexer', '[RepoIndexer] Vector store query failed:', error);
			}
		}

		const timeoutPromise = new Promise<{ timedOut: boolean }>((resolve) => {
			setTimeout(() => resolve({ timedOut: true }), RepoIndexerService.QUERY_TIMEOUT_MS);
		});

		// Check if disabled due to performance
		if (this._isDisabledDueToPerformance) {
			return this._fallbackToContextCache(text, k, startTime, { timedOut: false, earlyTerminated: false });
		}

		const results: string[] = [];
		const q = text.toLowerCase();
		let deduplicated: Array<{ entry: IndexEntry; chunk?: IndexChunk; score: number; isChunk: boolean }> = [];
		let timedOut = false;
		let earlyTerminated = false;

		// If index is empty, try to warm it first (non-blocking)
		if (this._index.length === 0 && !this._isWarmed) {
			// Trigger background warmup without waiting
			this.warmIndex(undefined).catch(() => { });
		}

		// First, try the on-disk index
		if (this._index.length > 0) {
			// Check common query cache first (for frequent patterns like "function", "class", etc.)
			const qLowerTrimmed = q.trim().toLowerCase();
			const commonQueryResult = this._commonQueryCache.get(qLowerTrimmed);
			if (commonQueryResult && commonQueryResult.length > 0) {
				// Use pre-computed results as starting point
				const precomputedEntries = commonQueryResult.slice(0, Math.min(k * 2, commonQueryResult.length))
					.map(idx => ({ entry: this._index[idx], score: 5, isChunk: false }));
				if (precomputedEntries.length > 0) {
					// Score and rerank pre-computed entries
					const qTokens = this._tokenize(q);
					const scored = precomputedEntries.map(({ entry, score }) => {
						const newScore = this._scoreEntryFast(q, qTokens, entry);
						return { entry, score: newScore, isChunk: false };
					}).filter(item => item.score > 0);

					if (scored.length > 0) {
						const reranked = this._rerankBM25Fast(q, qTokens, scored, k);
						const topResults = reranked.slice(0, k);
						results.push(...topResults.map(({ entry }) => {
							return this._formatResult(entry, undefined, q);
						}));

						if (results.length >= k) {
							// We have enough results from common query cache
							const retrievalLatencyMs = performance.now() - startTime;
							const tokensInjected = results.reduce((sum, r) => sum + Math.ceil(r.length / 4), 0);
							const metrics: QueryMetrics = {
								retrievalLatencyMs,
								tokensInjected,
								resultsCount: results.length,
								topScore: reranked[0]?.score,
								timedOut: false,
								earlyTerminated: false
							};
							this._cacheQueryResult(cacheKey, results, metrics);
							return { results, metrics };
						}
					}
				}
			}

			// Use inverted indexes to find candidate entries with smart filtering
			const qTokens = this._tokenize(q);
			const qTokenArray = Array.from(qTokens);

			// Strategy: Prioritize entries that match ALL terms (intersection), then those matching ANY term (union)
			let candidateIndices: Set<number>;

			if (qTokenArray.length === 0) {
				// No tokens, fall back to limited scan
				candidateIndices = new Set(Array.from({ length: Math.min(this._index.length, 100) }, (_, i) => i));
			} else if (qTokenArray.length === 1) {
				// Single token - use direct lookup
				const token = qTokenArray[0];
				candidateIndices = new Set<number>();
				this._termIndex.get(token)?.forEach(idx => candidateIndices.add(idx));
				this._symbolIndex.get(token)?.forEach(idx => candidateIndices.add(idx));
			} else {
				// Multiple tokens - use intersection for precision, union as fallback
				const termMatches: Set<number>[] = [];
				const symbolMatches: Set<number>[] = [];

				for (const token of qTokenArray) {
					const termSet = this._termIndex.get(token);
					if (termSet && termSet.size > 0) {
						termMatches.push(termSet);
					}
					const symbolSet = this._symbolIndex.get(token);
					if (symbolSet && symbolSet.size > 0) {
						symbolMatches.push(symbolSet);
					}
				}

				// Try intersection first (entries matching ALL terms) - most precise
				if (termMatches.length > 0) {
					candidateIndices = this._setIntersection(termMatches);
					// Add symbol matches too
					if (symbolMatches.length > 0) {
						const symbolIntersection = this._setIntersection(symbolMatches);
						for (const idx of symbolIntersection) {
							candidateIndices.add(idx);
						}
					}
				} else if (symbolMatches.length > 0) {
					candidateIndices = this._setIntersection(symbolMatches);
				} else {
					// No matches found, use limited fallback
					candidateIndices = new Set(Array.from({ length: Math.min(this._index.length, 100) }, (_, i) => i));
				}

				// If intersection is too small (< 10), also include union for recall
				if (candidateIndices.size < 10 && termMatches.length > 0) {
					const unionSet = this._setUnion(termMatches);
					// Add top 50 from union to ensure we have enough candidates
					const unionArray = Array.from(unionSet).slice(0, 50);
					for (const idx of unionArray) {
						candidateIndices.add(idx);
					}
				}
			}

			const entriesToScore = Array.from(candidateIndices);

			// Score entries with early termination and timeout protection
			const scoredItems: Array<{ entry: IndexEntry; chunk?: IndexChunk; score: number; isChunk: boolean }> = [];
			let highScoreCount = 0; // Count of items with score >= 5 (good matches)

			// Race between scoring and timeout
			const scoringPromise = (async () => {
				for (let i = 0; i < entriesToScore.length; i++) {
					// Check timeout more frequently (every 5 entries instead of 10) for better responsiveness
					if (i % 5 === 0 && performance.now() - startTime > RepoIndexerService.QUERY_TIMEOUT_MS) {
						timedOut = true;
						break;
					}

					const entryIndex = entriesToScore[i];
					const entry = this._index[entryIndex];
					if (!entry) { continue; }

					// Score main snippet (using pre-computed tokens for faster matching)
					const mainScore = this._scoreEntryFast(q, qTokens, entry);
					if (mainScore > 0) {
						scoredItems.push({ entry, score: mainScore, isChunk: false });
						if (mainScore >= 5) { highScoreCount++; }
					}

					// Lazy chunk evaluation: only score chunks if main snippet score is promising
					// This avoids wasting time on chunks from low-scoring entries
					if (mainScore >= 2 && entry.chunks && entry.chunks.length > 0) {
						const chunksToScore = Math.min(entry.chunks.length, 3); // Limit to 3 chunks per file
						for (let j = 0; j < chunksToScore; j++) {
							const chunk = entry.chunks![j];
							const chunkScore = this._scoreChunkFast(q, qTokens, chunk);
							if (chunkScore > 0) {
								scoredItems.push({ entry, chunk, score: chunkScore, isChunk: true });
								if (chunkScore >= 5) { highScoreCount++; }
							}
						}
					}

					// Early termination: if we have enough high-scoring candidates, stop
					if (highScoreCount >= RepoIndexerService.EARLY_TERMINATION_CANDIDATES) {
						earlyTerminated = true;
						break;
					}
				}
			})();

			// Race between scoring and timeout
			const raceResult = await Promise.race([scoringPromise, timeoutPromise]);
			if (typeof raceResult === 'object' && raceResult !== null && raceResult.timedOut) {
				timedOut = true;
			}

			// Nearest fragments by meaning: found even when they share no word with the question
			const queryVector = queryEmbedding ? truncateVector(queryEmbedding) : undefined;
			const vectorItems = queryVector ? this._vectorCandidates(queryVector, RepoIndexerService.VECTOR_CANDIDATES) : [];

			// If we have results, process them
			if (scoredItems.length > 0 || vectorItems.length > 0) {
				// Use partial sort for top-k instead of full sort (more efficient)
				const rerankPoolSize = Math.min(k * 3, scoredItems.length, 30); // Slightly larger pool for better results
				const rerankPool = this._partialSort(scoredItems, rerankPoolSize);

				// Apply hybrid reranking (BM25 + vector) if vector store enabled, otherwise BM25-only
				const reranked = (this.vectorStore.isEnabled() && vectorResults.length > 0)
					? this._rerankHybridWithVectorStore(q, qTokens, rerankPool, vectorResults, k)
					: (vectorItems.length > 0
						// Places are fused, not scores: BM25 and cosine live on different scales
						? fuseRankings([this._rerankBM25Fast(q, qTokens, rerankPool, rerankPool.length), vectorItems], item => `${item.entry.uri}#${item.chunk?.startLine ?? 0}`)
						: this._rerankBM25Fast(q, qTokens, rerankPool, k));

				// Deduplicate by URI (keep highest-scoring item per file)
				const seenUris = new Set<string>();
				deduplicated = reranked.filter(({ entry }) => {
					if (seenUris.has(entry.uri)) {
						return false;
					}
					seenUris.add(entry.uri);
					return true;
				});

				// Take top k and format with citations
				const topResults = deduplicated.slice(0, k);

				results.push(...topResults.map(({ entry, chunk }) => {
					return this._formatResult(entry, chunk, q);
				}));
			}
		}

		// Fallback to context cache if index is empty or timed out
		if (results.length === 0 || timedOut) {
			return this._fallbackToContextCache(text, k, startTime, { timedOut, earlyTerminated });
		}

		const retrievalLatencyMs = performance.now() - startTime;
		const tokensInjected = results.reduce((sum, r) => sum + Math.ceil(r.length / 4), 0);

		// Get top score from deduplicated results if available
		let topScore: number | undefined;
		if (this._index.length > 0 && deduplicated && deduplicated.length > 0) {
			topScore = deduplicated[0].score;
		}

		// Track performance metrics
		this._trackPerformance(retrievalLatencyMs);

		const metrics: QueryMetrics = {
			retrievalLatencyMs,
			tokensInjected,
			resultsCount: results.length,
			topScore,
			timedOut,
			earlyTerminated,
			embeddingLatencyMs: embeddingLatencyMs > 0 ? embeddingLatencyMs : undefined,
			hybridSearchUsed: queryEmbedding !== undefined && this._vectors.size > 0
		};

		// Cache result (with LRU eviction)
		this._cacheQueryResult(cacheKey, results, metrics);

		return {
			results,
			metrics
		};
	}

	/**
	 * Cache query result with O(1) LRU eviction (automatic via LRUCache)
	 */
	private _cacheQueryResult(key: string, results: string[], metrics: QueryMetrics): void {
		// LRUCache automatically handles eviction in O(1) time
		this._queryCache.set(key, {
			results,
			metrics,
			timestamp: performance.now()
		});
	}

	/**
	 * Format an index entry as a result string with citations
	 */
	private _formatResult(entry: IndexEntry, chunk: IndexChunk | undefined, query: string): string {
		const parts: string[] = [];

		// Format file path with line range citation
		let fileHeader = `File: ${entry.uri}`;
		let citationStartLine = entry.snippetStartLine || 1;
		let citationEndLine = entry.snippetEndLine || 1;

		if (chunk) {
			// Use chunk line numbers if available
			citationStartLine = chunk.startLine;
			citationEndLine = chunk.endLine;
		}

		if (citationStartLine === citationEndLine) {
			fileHeader += `:${citationStartLine}`;
		} else {
			fileHeader += `:${citationStartLine}-${citationEndLine}`;
		}
		parts.push(fileHeader);

		// Add symbols if available
		if (entry.symbols.length > 0) {
			const qLower = query.toLowerCase();
			const matchingSymbols = entry.symbols.filter(s =>
				s.toLowerCase().includes(qLower) || qLower.includes(s.toLowerCase())
			);
			const otherSymbols = entry.symbols.filter(s =>
				!matchingSymbols.includes(s)
			);
			const prioritizedSymbols = [...matchingSymbols.slice(0, 5), ...otherSymbols.slice(0, 5)].slice(0, 10);
			parts.push(`Symbols: ${prioritizedSymbols.join(', ')}`);
		}

		// Add snippet or chunk text with citation
		const displayText = chunk ? chunk.text : entry.snippet;
		if (displayText) {
			parts.push(`Content preview:\n${displayText}`);
		}

		return parts.join('\n');
	}

	private _fallbackToContextCache(text: string, k: number, startTime: number, flags: { timedOut: boolean; earlyTerminated: boolean }): Promise<{ results: string[]; metrics: QueryMetrics }> {
		const q = text.toLowerCase();
		const results: string[] = [];
		const snippets = this.contextGatheringService.getCachedSnippets();
		if (snippets.length > 0) {
			const scored = snippets.map(s => ({ s, score: this._score(q, s.toLowerCase()) }))
				.sort((a, b) => b.score - a.score)
				.slice(0, k)
				.map(x => x.s);
			results.push(...scored);
		}

		const retrievalLatencyMs = performance.now() - startTime;
		const tokensInjected = results.reduce((sum, r) => sum + Math.ceil(r.length / 4), 0);

		return Promise.resolve({
			results,
			metrics: {
				retrievalLatencyMs,
				tokensInjected,
				resultsCount: results.length,
				timedOut: flags.timedOut,
				earlyTerminated: flags.earlyTerminated
			}
		});
	}

	private _trackPerformance(latencyMs: number): void {
		// Add to recent latencies with O(1) running average
		if (this._recentLatencies.length >= RepoIndexerService.MAX_LATENCY_HISTORY) {
			// Remove oldest value from sum
			const removed = this._recentLatencies.shift()!;
			this._runningSum -= removed;
		}
		this._recentLatencies.push(latencyMs);
		this._runningSum += latencyMs;

		// Check if we should disable due to poor performance (O(1) average calculation)
		if (this._recentLatencies.length >= RepoIndexerService.MIN_QUERIES_FOR_DISABLE) {
			const avgLatency = this._runningSum / this._recentLatencies.length;
			if (avgLatency > RepoIndexerService.PERFORMANCE_THRESHOLD_MS && !this._isDisabledDueToPerformance) {
				this._isDisabledDueToPerformance = true;
				vibeLog.warn('repoIndexer', `[RepoIndexer] Disabled due to poor performance (avg latency: ${avgLatency.toFixed(1)}ms). Will re-enable after index rebuild.`);
			}
		}
	}

	/**
	 * Fast chunk scoring using pre-computed tokens
	 */
	private _scoreChunkFast(q: string, qTokens: Set<string>, chunk: IndexChunk): number {
		const qLower = q.toLowerCase();
		const chunkText = chunk.text;
		const chunkLower = chunkText.toLowerCase();

		// Tokens should always be pre-computed during indexing, but fallback if missing
		if (!chunk.tokens) {
			chunk.tokens = this._tokenize(chunkText);
		}

		let score = 0;
		// Exact phrase match
		if (chunkLower.includes(qLower)) {
			score += 5;
		}

		// Token overlap using Set intersection (more efficient than iteration)
		// Count intersection size directly
		let tokenMatches = 0;
		for (const token of qTokens) {
			if (chunk.tokens.has(token)) {
				tokenMatches++;
			}
		}
		// Alternative: could use intersection size, but iteration is already O(n) and simpler
		score += tokenMatches * 2;

		// Length normalization (prefer shorter, more focused chunks)
		const lengthFactor = Math.min(chunkText.length / 500, 1); // Favor chunks under 500 chars
		score *= (1.2 - lengthFactor * 0.2);

		return score;
	}

	/**
	 * Update BM25 statistics for an entry incrementally (faster than recomputing)
	 */
	private _updateBM25StatsForEntry(entryIndex: number, entry: IndexEntry): void {
		const docText = entry.snippet;
		const docLength = docText.length;
		const docLower = docText.toLowerCase();
		const termFrequencies = new Map<string, number>();

		// Use pre-computed tokens if available for faster term frequency calculation
		if (entry.snippetTokens) {
			// Count occurrences for each token
			for (const token of entry.snippetTokens) {
				const matches = docLower.match(new RegExp(`\\b${token}\\b`, 'g'));
				termFrequencies.set(token, matches ? matches.length : 1);
			}
		} else {
			// Fallback: tokenize and count
			const tokens = this._tokenize(docText);
			for (const token of tokens) {
				const matches = docLower.match(new RegExp(`\\b${token}\\b`, 'g'));
				termFrequencies.set(token, matches ? matches.length : 1);
			}
		}

		// Update cache with new stats
		this._bm25StatsCache.set(entryIndex, { docLength, termFrequencies });
	}


	/**
	 * Get cached average document length (computed once, invalidated on index changes)
	 */
	private _getAvgDocLength(): number {
		if (!this._avgDocLengthDirty && this._cachedAvgDocLength > 0) {
			return this._cachedAvgDocLength;
		}

		if (this._index.length === 0) {
			this._cachedAvgDocLength = 0;
			this._avgDocLengthDirty = false;
			return 0;
		}

		// Compute average from all entries
		let totalLength = 0;
		for (const entry of this._index) {
			totalLength += entry.snippet.length;
			if (entry.chunks) {
				for (const chunk of entry.chunks) {
					totalLength += chunk.text.length;
				}
			}
		}
		const totalDocs = this._index.length + this._index.reduce((sum, e) => sum + (e.chunks?.length || 0), 0);
		this._cachedAvgDocLength = totalDocs > 0 ? totalLength / totalDocs : 0;
		this._avgDocLengthDirty = false;
		return this._cachedAvgDocLength;
	}

	/**
	 * Optimized BM25 reranking with pre-computed tokens and cached term frequencies
	 */
	private _rerankBM25Fast(query: string, qTokens: Set<string>, items: Array<{ entry: IndexEntry; chunk?: IndexChunk; score: number; isChunk: boolean }>, k: number): typeof items {
		if (items.length === 0) { return items; }
		if (qTokens.size === 0) { return items; }

		// Use cached average document length (much faster than computing per query)
		const avgDocLength = this._getAvgDocLength() || items.reduce((sum, item) => {
			const text = item.chunk ? item.chunk.text : item.entry.snippet;
			return sum + text.length;
		}, 0) / items.length;

		// Pre-compute IDF for each query token (cache this)
		const idfCache = new Map<string, number>();
		const qTokenArray = Array.from(qTokens);

		for (const qToken of qTokenArray) {
			// Count documents containing this token (use pre-computed tokens for speed)
			let docCount = 0;
			for (const item of items) {
				const docTokens = item.chunk?.tokens || item.entry.snippetTokens;
				if (docTokens && docTokens.has(qToken)) {
					docCount++;
				} else if (!docTokens) {
					// Fallback: check text if tokens not available
					const docText = item.chunk ? item.chunk.text : item.entry.snippet;
					const docLower = docText.toLowerCase();
					if (docLower.includes(qToken)) {
						docCount++;
					}
				}
			}
			idfCache.set(qToken, Math.log((items.length + 1) / (docCount + 1)));
		}

		// BM25 parameters (tuned for code retrieval)
		const k1 = 1.2;
		const b = 0.75;

		// Score each item (use cached BM25 stats if available)
		const scored = items.map((item) => {
			const docText = item.chunk ? item.chunk.text : item.entry.snippet;

			// Try to get cached BM25 stats (faster than computing on the fly)
			// Use path index for O(1) lookup instead of findIndex
			const entryIndex = this._pathIndex.get(item.entry.uri.toLowerCase());
			const cachedStats = entryIndex !== undefined ? this._bm25StatsCache.get(entryIndex) : undefined;

			let docLength = docText.length;
			let termFrequencies: Map<string, number> | undefined;

			// Use cached stats if available, otherwise compute
			if (cachedStats && !item.chunk) {
				// For main snippet, use cached stats
				docLength = cachedStats.docLength;
				termFrequencies = cachedStats.termFrequencies;
			} else {
				// For chunks or if no cache, compute on the fly
				docLength = docText.length;
			}

			// Get pre-computed tokens if available
			const docTokens = item.chunk?.tokens || item.entry.snippetTokens;

			let bm25Score = item.score; // Start with base score

			// BM25 term scoring with cached term frequencies
			for (const qToken of qTokenArray) {
				let termFreq = 0;

				if (docTokens && docTokens.has(qToken)) {
					// Token exists, get frequency from cached stats or compute
					if (termFrequencies) {
						termFreq = termFrequencies.get(qToken) || 0;
					} else {
						// Compute term frequency (only if not cached)
						const docLower = docText.toLowerCase();
						const matches = docLower.match(new RegExp(`\\b${qToken}\\b`, 'g'));
						termFreq = matches ? matches.length : 1;
					}
				} else {
					continue; // Token not in document
				}

				const idf = idfCache.get(qToken) || 0;
				const numerator = termFreq * (k1 + 1);
				const denominator = termFreq + k1 * (1 - b + b * (docLength / avgDocLength));
				bm25Score += idf * (numerator / denominator) * 0.3; // Blend with base score
			}

			return { ...item, score: bm25Score };
		});

		// Partial sort for top results
		return this._partialSort(scored, Math.min(k * 2, scored.length));
	}

	/**
	 * Hybrid reranking using vector store results (BM25 + vector store scores)
	 * PERFORMANCE: Only processes top BM25 candidates to avoid unnecessary work
	 */
	private _rerankHybridWithVectorStore(
		query: string,
		qTokens: Set<string>,
		items: Array<{ entry: IndexEntry; chunk?: IndexChunk; score: number; isChunk: boolean }>,
		vectorResults: Array<{ id: string; score: number }>,
		k: number
	): typeof items {
		if (items.length === 0) { return items; }

		// Create a map of vector store scores by document ID (O(1) lookups)
		const vectorScoreMap = new Map<string, number>();
		for (const vr of vectorResults) {
			vectorScoreMap.set(vr.id, vr.score);
		}

		// PERFORMANCE: Filter to top BM25 candidates first (items already have BM25 scores)
		// Only compute hybrid scores for top candidates, not all items
		const topBM25Count = Math.min(k * 1.5, items.length); // Get top 1.5k candidates for hybrid scoring
		const bm25Reranked = this._partialSort(items, topBM25Count);

		// Hybrid weights (tuned for code retrieval: BM25 for exact matches, vector for semantic similarity)
		const BM25_WEIGHT = 0.6;
		const VECTOR_WEIGHT = 0.4;

		// Normalize BM25 scores to 0-1 range for blending
		const bm25Scores = bm25Reranked.map(item => item.score);
		const maxBm25 = Math.max(...bm25Scores, 1);
		const minBm25 = Math.min(...bm25Scores, 0);

		// Compute hybrid scores
		const hybridScored = bm25Reranked.map((item) => {
			// Normalize BM25 score to 0-1
			const normalizedBm25 = maxBm25 > minBm25
				? (item.score - minBm25) / (maxBm25 - minBm25)
				: 0.5;

			// Get vector score from vector store results
			// Document ID format: `${entry.uri}:${chunkIndex}` or `${entry.uri}`
			const docId = item.chunk
				? `${item.entry.uri}:${item.entry.chunks?.indexOf(item.chunk) ?? -1}`
				: `${item.entry.uri}`;
			const vectorScore = vectorScoreMap.get(docId) || 0;

			// Weighted blend
			const hybridScore = (normalizedBm25 * BM25_WEIGHT) + (vectorScore * VECTOR_WEIGHT);

			return { ...item, score: hybridScore };
		});

		// Partial sort for top results
		return this._partialSort(hybridScored, Math.min(k, hybridScored.length));
	}

	/**
	 * Partial sort: efficiently get top-k items using min-heap
	 * O(n log k) complexity instead of O(n log n) for full sort
	 */
	private _partialSort<T extends { score: number }>(items: T[], k: number): T[] {
		if (items.length <= k) {
			// Small array, just sort it
			return items.sort((a, b) => {
				if (Math.abs(a.score - b.score) < 0.1) {
					return 0; // Stable sort
				}
				return b.score - a.score;
			});
		}

		// Use min-heap for O(n log k) instead of O(n log n)
		// The heap maintains the k highest-scoring items
		const heap: Array<{ score: number; item: T }> = [];

		// Helper functions for min-heap operations
		const heapifyUp = (idx: number) => {
			while (idx > 0) {
				const parent = Math.floor((idx - 1) / 2);
				if (heap[parent].score <= heap[idx].score) { break; }
				[heap[parent], heap[idx]] = [heap[idx], heap[parent]];
				idx = parent;
			}
		};

		const heapifyDown = (idx: number) => {
			while (true) {
				let smallest = idx;
				const left = 2 * idx + 1;
				const right = 2 * idx + 2;

				if (left < heap.length && heap[left].score < heap[smallest].score) {
					smallest = left;
				}
				if (right < heap.length && heap[right].score < heap[smallest].score) {
					smallest = right;
				}
				if (smallest === idx) { break; }
				[heap[idx], heap[smallest]] = [heap[smallest], heap[idx]];
				idx = smallest;
			}
		};

		// Build min-heap of top k items
		for (const item of items) {
			if (heap.length < k) {
				heap.push({ score: item.score, item });
				heapifyUp(heap.length - 1);
			} else if (item.score > heap[0].score) {
				// Replace minimum (root) with new item if it's larger
				heap[0] = { score: item.score, item };
				heapifyDown(0);
			}
		}

		// Extract items from heap and sort descending
		const result = heap.map(h => h.item);
		return result.sort((a, b) => {
			if (Math.abs(a.score - b.score) < 0.1) {
				return 0;
			}
			return b.score - a.score;
		});
	}

	/**
	 * Efficient set intersection for multiple sets
	 * Optimized: Use sorted arrays with binary search for large sets (faster than Set.has)
	 */
	private _setIntersection(sets: Set<number>[]): Set<number> {
		if (sets.length === 0) { return new Set(); }
		if (sets.length === 1) { return new Set(sets[0]); }

		// Start with the smallest set for efficiency
		sets.sort((a, b) => a.size - b.size);
		let result = new Set(sets[0]);

		// For large sets, convert to sorted arrays and use binary search
		for (let i = 1; i < sets.length; i++) {
			const currentSet = sets[i];
			const newResult = new Set<number>();

			// Use optimized approach based on set sizes
			if (result.size < 100 || currentSet.size < 100) {
				// Small sets: use Set.has (faster for small sets)
				for (const val of result) {
					if (currentSet.has(val)) {
						newResult.add(val);
					}
				}
			} else {
				// Large sets: convert to sorted arrays and use binary search
				const resultArray = Array.from(result).sort((a, b) => a - b);
				const currentArray = Array.from(currentSet).sort((a, b) => a - b);

				let resultIdx = 0;
				let currentIdx = 0;
				while (resultIdx < resultArray.length && currentIdx < currentArray.length) {
					if (resultArray[resultIdx] === currentArray[currentIdx]) {
						newResult.add(resultArray[resultIdx]);
						resultIdx++;
						currentIdx++;
					} else if (resultArray[resultIdx] < currentArray[currentIdx]) {
						resultIdx++;
					} else {
						currentIdx++;
					}
				}
			}

			result = newResult;
			if (result.size === 0) { break; } // Early exit
		}

		return result;
	}

	/**
	 * Efficient set union for multiple sets
	 */
	private _setUnion(sets: Set<number>[]): Set<number> {
		const result = new Set<number>();
		for (const set of sets) {
			for (const val of set) {
				result.add(val);
			}
		}
		return result;
	}

	private _setupFileWatcher(): void {
		// Dispose existing watcher
		if (this._fileWatcher) {
			this._fileWatcher.dispose();
			this._fileWatcher = undefined;
		}

		const workspace = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!workspace) { return; }

		// Watch workspace for file changes (recursive, with exclusions)
		const watcher = this.fileService.watch(workspace, {
			recursive: true,
			excludes: [
				'**/node_modules/**',
				'**/.git/**',
				'**/dist/**',
				'**/build/**',
				'**/out/**',
				'**/.vscode/**',
				'**/.idea/**',
				'**/coverage/**',
				'**/.nyc_output/**',
				'**/.next/**',
				'**/.cache/**'
			]
		});

		// Listen to file changes and register as disposable
		this._register(this.fileService.onDidFilesChange(e => {
			this._handleFileChanges(e);
		}));

		// Store watcher reference for disposal
		this._fileWatcher = watcher;
	}

	private _handleFileChanges(e: FileChangesEvent): void {
		const workspace = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!workspace) { return; }

		// The ignore rules themselves changed: reread them and drop what they now exclude
		// Files they stop excluding come in with the next full rebuild — the walk is what finds files nobody touched
		const rules = [joinPath(workspace, '.gitignore'), joinPath(workspace, '.vibe', 'ignore')];
		if (rules.some(rule => e.contains(rule))) {
			void this._loadIgnore(workspace).then(() => this._dropExcluded(workspace));
		}

		// Process deleted files (immediate removal)
		for (const resource of e.rawDeleted) {
			const path = resource.fsPath;

			// Same rule as the walk: inside the project, not ignored, an indexed kind of file
			if (!this._isIndexable(workspace, resource, false)) { continue; }

			// Find and remove from index
			const entryIndex = this._index.findIndex(entry => entry.uri === path);
			if (entryIndex >= 0) {
				this._removeFromInvertedIndexes(entryIndex);
				this._index.splice(entryIndex, 1);
				// Update indices in inverted indexes (shift all indices after removed entry)
				this._rebuildInvertedIndexes(); // Simpler: rebuild after deletion
				this._onDidChangeStructure.fire();
			}
			// Remove from file content cache
			this._fileContentCache.delete(path);
			this._pendingUpdates.delete(path);
		}

		// Process added/updated files (mark for incremental update)
		for (const resource of [...e.rawAdded, ...e.rawUpdated]) {
			const path = resource.fsPath;

			// Same rule as the walk: inside the project, not ignored, an indexed kind of file
			if (!this._isIndexable(workspace, resource, false)) { continue; }

			// Invalidate file content cache for updated files (will be refreshed on next read)
			this._fileContentCache.delete(path);

			// Mark for incremental update
			this._pendingUpdates.add(path);
		}

		// Schedule debounced incremental update
		if (this._pendingUpdates.size > 0 && !this._incrementalUpdateScheduler.isScheduled()) {
			this._incrementalUpdateScheduler.schedule();
		}
	}

	private _dropExcluded(workspace: URI): void {
		const before = this._index.length;
		this._index = this._index.filter(entry => this._isIndexable(workspace, URI.file(entry.uri), false));
		if (this._index.length !== before) {
			this._rebuildInvertedIndexes();
			this._onDidChangeStructure.fire();
			this._saveIndexScheduler.schedule();
		}
	}

	private async _processPendingUpdates(): Promise<void> {
		if (this._pendingUpdates.size === 0) { return; }

		const urisToUpdate = Array.from(this._pendingUpdates);
		this._pendingUpdates.clear();

		let updatedCount = 0;
		let failedCount = 0;

		// Process updates in parallel batches with CPU throttling
		const perfSettings = this.settingsService.state.globalSettings.perf;
		const parallelism = perfSettings?.indexerParallelism ?? 2; // Default 2 parallel workers
		const maxConcurrent = Math.min(parallelism, RepoIndexerService.BATCH_SIZE);

		for (let i = 0; i < urisToUpdate.length; i += maxConcurrent) {
			// Throttle CPU before processing batch
			await this._throttleCpu();

			const batch = urisToUpdate.slice(i, i + maxConcurrent);

			const results = await Promise.allSettled(
				batch.map(async (uriPath) => {
					const uri = URI.file(uriPath);

					// Check if file still exists (might have been deleted during debounce)
					try {
						await this.fileService.stat(uri);
					} catch {
						// File doesn't exist, remove from index if present
						this._index = this._index.filter(entry => entry.uri !== uriPath);
						throw new Error('File deleted');
					}

					// Extract symbols and snippet
					const symbols = await this._extractSymbols(uri);
					const snippetResult = await this._extractSnippet(uri);
					const { snippet, startLine, endLine, chunks } = snippetResult;

					// Extract imports from file content
					const fileContent = this._fileContentCache.get(uriPath) ||
						(await this.fileService.readFile(uri)).value.toString();
					const { importedSymbols, importedFrom } = this._extractImports(fileContent);

					// Update or add index entry
					// PERFORMANCE: Use O(1) path index lookup instead of O(n) findIndex
					const existingIndex = this._pathIndex.get(uriPath.toLowerCase());
					const newEntry: IndexEntry = {
						uri: uriPath,
						symbols,
						snippet,
						snippetStartLine: startLine,
						snippetEndLine: endLine,
						chunks: chunks,
						importedSymbols: importedSymbols.length > 0 ? importedSymbols : undefined,
						importedFrom: importedFrom.length > 0 ? importedFrom : undefined
					};

					if (existingIndex !== undefined) {
						// Remove old entry from inverted indexes
						this._removeFromInvertedIndexes(existingIndex);
						this._index[existingIndex] = newEntry;
						// Add updated entry to inverted indexes
						this._updateInvertedIndexesForEntry(newEntry, existingIndex);
					} else {
						const entryIndex = this._index.length;
						this._index.push(newEntry);
						// Add new entry to inverted indexes
						this._updateInvertedIndexesForEntry(newEntry, entryIndex);
					}

					return true;
				})
			);

			// Count successes and failures
			for (const result of results) {
				if (result.status === 'fulfilled' && result.value === true) {
					updatedCount++;
				} else {
					failedCount++;
				}
			}

			// Track CPU usage
			const batchTime = performance.now();
			this._cpuTimeUsed += batchTime - (this._lastCpuCheck || batchTime);

			// Record indexer metrics if enabled
			if (perfSettings?.enable && updatedCount > 0) {
				const filesPerSec = (updatedCount / ((batchTime - (this._lastCpuCheck || batchTime)) / 1000));
				const avgParseMs = (batchTime - (this._lastCpuCheck || batchTime)) / updatedCount;
				const cpuBudgetHit = this._cpuTimeUsed / (batchTime - (this._lastCpuCheck || batchTime)) > this._cpuBudget;
				const harness = getPerformanceHarness(true);
				harness.recordIndexer(filesPerSec, avgParseMs, cpuBudgetHit);
			}
		}

		// Schedule debounced save (don't save immediately)
		if (updatedCount > 0) {
			this._onDidChangeStructure.fire();
			this._saveIndexScheduler.schedule();
			// Optional: log updates in debug mode (vibeLog self-gates on level/category)
			vibeLog.debug('repoIndexer', `[RepoIndexer] Incrementally updated ${updatedCount} file(s)${failedCount > 0 ? `, ${failedCount} failed` : ''}`);
		}
	}

	/**
	 * Fast scoring using pre-computed tokens
	 */
	private _scoreEntryFast(q: string, qTokens: Set<string>, entry: IndexEntry): number {
		let score = 0;
		const qLower = q.toLowerCase();

		// Exact symbol name match (highest weight) - use pre-computed symbol tokens
		for (const sym of entry.symbols) {
			const symLower = sym.toLowerCase();
			if (symLower === qLower) {
				score += 10; // Exact match boost
			} else if (symLower.includes(qLower) || qLower.includes(symLower)) {
				score += 4; // Partial symbol match
			} else if (entry.symbolTokens) {
				// Token overlap in symbol name (using pre-computed tokens)
				for (const token of qTokens) {
					if (entry.symbolTokens.has(token)) { score += 2; }
				}
			}
		}

		// URI match (medium weight) - use pre-computed URI tokens
		if (entry.uriTokens) {
			for (const token of qTokens) {
				if (entry.uriTokens.has(token)) {
					score += 3;
					break; // URI match is binary
				}
			}
		} else {
			const uriLower = entry.uri.toLowerCase();
			if (uriLower.includes(qLower)) { score += 3; }
		}

		// Lexical overlap in snippet (weighted by token matches) - use pre-computed snippet tokens
		if (entry.snippetTokens) {
			let snippetTokenMatches = 0;
			for (const token of qTokens) {
				if (entry.snippetTokens.has(token)) {
					snippetTokenMatches++;
				}
			}
			if (snippetTokenMatches > 0) {
				// Weight by how many query tokens matched
				score += Math.min(snippetTokenMatches * 1.5, 5);
			}
		} else {
			// Fallback to old method if tokens not pre-computed
			const snippetLower = entry.snippet.toLowerCase();
			let snippetTokenMatches = 0;
			for (const token of qTokens) {
				if (snippetLower.includes(token)) {
					snippetTokenMatches++;
					if (snippetLower.split(/[^a-z0-9_]+/g).includes(token)) {
						snippetTokenMatches += 0.5;
					}
				}
			}
			if (snippetTokenMatches > 0) {
				score += Math.min(snippetTokenMatches * 1.5, 5);
			}
		}

		// Exact phrase match in snippet (lower weight but useful)
		const snippetLower = entry.snippet.toLowerCase();
		if (snippetLower.includes(qLower)) {
			score += 1;
		}

		return score;
	}

	private _score(q: string, doc: string): number {
		// very naive token overlap
		const qt = new Set(q.split(/[^a-z0-9_]+/g).filter(Boolean));
		let score = 0;
		for (const t of qt) { if (doc.includes(t)) { score += 1; } }
		return score;
	}

	/**
	 * Tokenize text into lowercase tokens (alphanumeric + underscore)
	 * Uses cache to avoid re-tokenizing same strings
	 */
	private _tokenize(text: string): Set<string> {
		// Check cache first
		const cached = this._tokenizationCache.get(text);
		if (cached) {
			return cached;
		}

		// Tokenize and cache
		const tokens = new Set(text.toLowerCase().split(/[^a-z0-9_]+/g).filter(Boolean));
		this._tokenizationCache.set(text, tokens);
		return tokens;
	}

	/** Vectors can be made now; the source itself says no for a cloud source without a network */
	private _canComputeEmbeddings(): boolean {
		return this._embeddings.state.ready;
	}

	/**
	 * Compute embeddings for text(s); the source redacts secrets itself
	 * Returns empty array if embeddings cannot be computed
	 */
	private async _computeEmbeddings(texts: string[], token: CancellationToken): Promise<number[][]> {
		if (!this._canComputeEmbeddings()) {
			return []; // Fallback to BM25-only
		}

		try {
			return await this._embeddings.embed(texts, token);
		} catch (error) {
			// Embedding computation failed, fallback to BM25-only
			vibeLog.debug('repoIndexer', '[RepoIndexer] Embedding computation failed, falling back to BM25:', error);
			return [];
		}
	}


	/**
	 * Rebuild all inverted indexes from the current _index array
	 */
	private _rebuildInvertedIndexes(): void {
		this._termIndex.clear();
		this._symbolIndex.clear();
		this._pathIndex.clear();
		this._languageIndex.clear();
		this._symbolRelationshipIndex.clear();
		this._pathHierarchyIndex.clear();
		// Note: We keep BM25 stats cache and update incrementally instead of clearing
		// Only clear stats for entries that no longer exist
		this._avgDocLengthDirty = true; // Mark average doc length as dirty

		for (let i = 0; i < this._index.length; i++) {
			const entry = this._index[i];

			// Index by URI
			this._pathIndex.set(entry.uri.toLowerCase(), i);

			// Index by file extension (language-specific index)
			const ext = entry.uri.split('.').pop()?.toLowerCase();
			if (ext) {
				if (!this._languageIndex.has(ext)) {
					this._languageIndex.set(ext, new Set());
				}
				this._languageIndex.get(ext)!.add(i);
			}

			// Index by directory path (path hierarchy)
			const dirPath = entry.uri.substring(0, entry.uri.lastIndexOf('/'));
			if (dirPath) {
				// Index by full directory path
				if (!this._pathHierarchyIndex.has(dirPath)) {
					this._pathHierarchyIndex.set(dirPath, new Set());
				}
				this._pathHierarchyIndex.get(dirPath)!.add(i);

				// Also index by parent directories (for hierarchical queries)
				const parts = dirPath.split('/');
				for (let j = 1; j < parts.length; j++) {
					const parentPath = parts.slice(0, j).join('/');
					if (!this._pathHierarchyIndex.has(parentPath)) {
						this._pathHierarchyIndex.set(parentPath, new Set());
					}
					this._pathHierarchyIndex.get(parentPath)!.add(i);
				}
			}

			// Index symbol relationships (imports)
			if (entry.importedSymbols) {
				for (const importedSymbol of entry.importedSymbols) {
					const symbolLower = importedSymbol.toLowerCase();
					if (!this._symbolRelationshipIndex.has(symbolLower)) {
						this._symbolRelationshipIndex.set(symbolLower, new Set());
					}
					this._symbolRelationshipIndex.get(symbolLower)!.add(i);
				}
			}

			// Pre-compute tokens if not already done
			if (!entry.snippetTokens) {
				entry.snippetTokens = this._tokenize(entry.snippet);
			}
			if (!entry.uriTokens) {
				entry.uriTokens = this._tokenize(entry.uri);
			}
			if (!entry.symbolTokens) {
				const allSymbolTokens = new Set<string>();
				for (const sym of entry.symbols) {
					const symTokens = this._tokenize(sym);
					for (const token of symTokens) {
						allSymbolTokens.add(token);
					}
				}
				entry.symbolTokens = allSymbolTokens;
			}

			// Index by terms in snippet
			for (const token of entry.snippetTokens) {
				if (!this._termIndex.has(token)) {
					this._termIndex.set(token, new Set());
				}
				this._termIndex.get(token)!.add(i);
			}

			// Index by terms in URI
			for (const token of entry.uriTokens) {
				if (!this._termIndex.has(token)) {
					this._termIndex.set(token, new Set());
				}
				this._termIndex.get(token)!.add(i);
			}

			// Index by symbol names (exact match)
			for (const symbol of entry.symbols) {
				const symbolLower = symbol.toLowerCase();
				if (!this._symbolIndex.has(symbolLower)) {
					this._symbolIndex.set(symbolLower, new Set());
				}
				this._symbolIndex.get(symbolLower)!.add(i);

				// Also index symbol tokens
				const symTokens = this._tokenize(symbol);
				for (const token of symTokens) {
					if (!this._termIndex.has(token)) {
						this._termIndex.set(token, new Set());
					}
					this._termIndex.get(token)!.add(i);
				}
			}
		}

		// Pre-compute common query patterns after rebuilding indexes
		this._precomputeCommonQueries();
	}

	/**
	 * Pre-compute results for common query patterns (e.g., "function", "class", etc.)
	 * This speeds up frequent queries significantly
	 */
	private _precomputeCommonQueries(): void {
		this._commonQueryCache.clear();

		for (const pattern of RepoIndexerService.COMMON_QUERY_PATTERNS) {
			const patternLower = pattern.toLowerCase();
			const patternTokens = this._tokenize(patternLower);
			const matchingIndices: number[] = [];

			// Find entries that match this pattern
			for (let i = 0; i < this._index.length; i++) {
				const entry = this._index[i];
				let score = 0;

				// Check if pattern appears in snippet
				if (entry.snippetTokens) {
					for (const token of patternTokens) {
						if (entry.snippetTokens.has(token)) {
							score += 2;
						}
					}
				}

				// Check if pattern appears in symbols
				for (const symbol of entry.symbols) {
					if (symbol.toLowerCase().includes(patternLower)) {
						score += 5;
					}
				}

				// Check if pattern appears in URI
				if (entry.uriTokens) {
					for (const token of patternTokens) {
						if (entry.uriTokens.has(token)) {
							score += 1;
						}
					}
				}

				if (score > 0) {
					matchingIndices.push(i);
				}
			}

			// Sort by relevance (simple scoring) and cache top results
			const sorted = matchingIndices.sort((a, b) => {
				const entryA = this._index[a];
				const entryB = this._index[b];
				// Simple scoring: prefer entries with pattern in symbols or snippet
				const scoreA = entryA.symbols.some(s => s.toLowerCase().includes(patternLower)) ? 10 : 5;
				const scoreB = entryB.symbols.some(s => s.toLowerCase().includes(patternLower)) ? 10 : 5;
				return scoreB - scoreA;
			});

			// Cache top 50 results per pattern
			this._commonQueryCache.set(patternLower, sorted.slice(0, 50));
		}
	}

	/**
	 * Update inverted indexes when adding/updating an entry at index i
	 */
	private _updateInvertedIndexesForEntry(entry: IndexEntry, entryIndex: number): void {
		// Remove old references (if updating)
		// Note: This is a simplified version - full implementation would track old values

		// Index by URI
		this._pathIndex.set(entry.uri.toLowerCase(), entryIndex);

		// Index by file extension (language-specific index)
		const ext = entry.uri.split('.').pop()?.toLowerCase();
		if (ext) {
			if (!this._languageIndex.has(ext)) {
				this._languageIndex.set(ext, new Set());
			}
			this._languageIndex.get(ext)!.add(entryIndex);
		}

		// Index by directory path (path hierarchy)
		const dirPath = entry.uri.substring(0, entry.uri.lastIndexOf('/'));
		if (dirPath) {
			if (!this._pathHierarchyIndex.has(dirPath)) {
				this._pathHierarchyIndex.set(dirPath, new Set());
			}
			this._pathHierarchyIndex.get(dirPath)!.add(entryIndex);

			// Also index by parent directories
			const parts = dirPath.split('/');
			for (let j = 1; j < parts.length; j++) {
				const parentPath = parts.slice(0, j).join('/');
				if (!this._pathHierarchyIndex.has(parentPath)) {
					this._pathHierarchyIndex.set(parentPath, new Set());
				}
				this._pathHierarchyIndex.get(parentPath)!.add(entryIndex);
			}
		}

		// Index symbol relationships (imports)
		if (entry.importedSymbols) {
			for (const importedSymbol of entry.importedSymbols) {
				const symbolLower = importedSymbol.toLowerCase();
				if (!this._symbolRelationshipIndex.has(symbolLower)) {
					this._symbolRelationshipIndex.set(symbolLower, new Set());
				}
				this._symbolRelationshipIndex.get(symbolLower)!.add(entryIndex);
			}
		}

		// Update BM25 stats incrementally instead of deleting (faster)
		this._updateBM25StatsForEntry(entryIndex, entry);
		this._avgDocLengthDirty = true; // Mark average doc length as dirty

		// Pre-compute tokens
		entry.snippetTokens = this._tokenize(entry.snippet);
		entry.uriTokens = this._tokenize(entry.uri);
		const allSymbolTokens = new Set<string>();
		for (const sym of entry.symbols) {
			const symTokens = this._tokenize(sym);
			for (const token of symTokens) {
				allSymbolTokens.add(token);
			}
		}
		entry.symbolTokens = allSymbolTokens;

		// Index by terms in snippet
		for (const token of entry.snippetTokens) {
			if (!this._termIndex.has(token)) {
				this._termIndex.set(token, new Set());
			}
			this._termIndex.get(token)!.add(entryIndex);
		}

		// Index by terms in URI
		for (const token of entry.uriTokens) {
			if (!this._termIndex.has(token)) {
				this._termIndex.set(token, new Set());
			}
			this._termIndex.get(token)!.add(entryIndex);
		}

		// Index by symbol names
		for (const symbol of entry.symbols) {
			const symbolLower = symbol.toLowerCase();
			if (!this._symbolIndex.has(symbolLower)) {
				this._symbolIndex.set(symbolLower, new Set());
			}
			this._symbolIndex.get(symbolLower)!.add(entryIndex);

			// Also index symbol tokens
			const symTokens = this._tokenize(symbol);
			for (const token of symTokens) {
				if (!this._termIndex.has(token)) {
					this._termIndex.set(token, new Set());
				}
				this._termIndex.get(token)!.add(entryIndex);
			}
		}
	}

	/**
	 * Remove entry from inverted indexes
	 */
	private _removeFromInvertedIndexes(entryIndex: number): void {
		const entry = this._index[entryIndex];
		if (!entry) { return; }

		// Remove from path index
		this._pathIndex.delete(entry.uri.toLowerCase());

		// Remove from language index
		const ext = entry.uri.split('.').pop()?.toLowerCase();
		if (ext) {
			this._languageIndex.get(ext)?.delete(entryIndex);
			if (this._languageIndex.get(ext)?.size === 0) {
				this._languageIndex.delete(ext);
			}
		}

		// Remove from path hierarchy index
		const dirPath = entry.uri.substring(0, entry.uri.lastIndexOf('/'));
		if (dirPath) {
			this._pathHierarchyIndex.get(dirPath)?.delete(entryIndex);
			if (this._pathHierarchyIndex.get(dirPath)?.size === 0) {
				this._pathHierarchyIndex.delete(dirPath);
			}
			// Also remove from parent directories
			const parts = dirPath.split('/');
			for (let j = 1; j < parts.length; j++) {
				const parentPath = parts.slice(0, j).join('/');
				this._pathHierarchyIndex.get(parentPath)?.delete(entryIndex);
				if (this._pathHierarchyIndex.get(parentPath)?.size === 0) {
					this._pathHierarchyIndex.delete(parentPath);
				}
			}
		}

		// Remove from symbol relationship index
		if (entry.importedSymbols) {
			for (const importedSymbol of entry.importedSymbols) {
				const symbolLower = importedSymbol.toLowerCase();
				this._symbolRelationshipIndex.get(symbolLower)?.delete(entryIndex);
				if (this._symbolRelationshipIndex.get(symbolLower)?.size === 0) {
					this._symbolRelationshipIndex.delete(symbolLower);
				}
			}
		}

		// Remove from BM25 stats cache
		this._bm25StatsCache.delete(entryIndex);
		this._avgDocLengthDirty = true; // Mark average doc length as dirty

		// Remove from term index
		if (entry.snippetTokens) {
			for (const token of entry.snippetTokens) {
				this._termIndex.get(token)?.delete(entryIndex);
				if (this._termIndex.get(token)?.size === 0) {
					this._termIndex.delete(token);
				}
			}
		}
		if (entry.uriTokens) {
			for (const token of entry.uriTokens) {
				this._termIndex.get(token)?.delete(entryIndex);
				if (this._termIndex.get(token)?.size === 0) {
					this._termIndex.delete(token);
				}
			}
		}

		// Remove from symbol index
		for (const symbol of entry.symbols) {
			const symbolLower = symbol.toLowerCase();
			this._symbolIndex.get(symbolLower)?.delete(entryIndex);
			if (this._symbolIndex.get(symbolLower)?.size === 0) {
				this._symbolIndex.delete(symbolLower);
			}

			// Remove symbol tokens
			const symTokens = this._tokenize(symbol);
			for (const token of symTokens) {
				this._termIndex.get(token)?.delete(entryIndex);
				if (this._termIndex.get(token)?.size === 0) {
					this._termIndex.delete(token);
				}
			}
		}
	}
}

registerSingleton(IRepoIndexerService, RepoIndexerService, InstantiationType.Eager);


