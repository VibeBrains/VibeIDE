/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { vibeLog } from './vibeLog.js';
import { Disposable, IReference } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IFileService, FileOperationError, FileOperationResult, FileSystemProviderError, FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { LRUCache } from '../../../../base/common/map.js';

// A missing file surfaces as EITHER a FileOperationError (FILE_NOT_FOUND) OR a raw
// FileSystemProviderError (code FileNotFound, i.e. "EntryNotFound") depending on which
// layer threw. Recognising only the former let ENOENT slip through, re-throw, and spam
// "InitializeModel error" hundreds of times for one missing path (model-stalls #013).
//
// #013 round-2: when the error originates in the MAIN-process file service and is
// marshaled across IPC into the renderer, it loses its prototype — both `instanceof`
// checks return false (stack lands in main.js), so ENOENT slipped through again,
// re-threw, and never populated the existence cache → per-tick spam while the agent
// creates a NOT-YET-EXISTING file (`<workspace>/.vibe/rules/dev.md`). `toFileSystemProviderErrorCode`
// is prototype-independent: it reads the code off `error.name` ("EntryNotFound (FileSystemError)").
const isFileNotFoundError = (err: unknown): boolean =>
	(err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)
	|| (err instanceof FileSystemProviderError && err.code === FileSystemProviderErrorCode.FileNotFound)
	|| toFileSystemProviderErrorCode(err as Error) === FileSystemProviderErrorCode.FileNotFound;

type VibeideModelType = {
	model: ITextModel | null;
	editorModel: IResolvedTextEditorModel | null;
};

export interface IVibeideModelService {
	readonly _serviceBrand: undefined;
	initializeModel(uri: URI): Promise<void>;
	getModel(uri: URI): VibeideModelType;
	getModelFromFsPath(fsPath: string): VibeideModelType;
	getModelSafe(uri: URI): Promise<VibeideModelType>;
	saveModel(uri: URI): Promise<void>;
	/** Drop the cached existence result for a path so the next initializeModel re-stats it. */
	invalidateExistenceCache(uri: URI): void;

}

export const IVibeideModelService = createDecorator<IVibeideModelService>('vibeideModelService');

class VibeideModelService extends Disposable implements IVibeideModelService {
	_serviceBrand: undefined;
	static readonly ID = 'vibeideModelService';
	private readonly _modelRefOfURI: Record<string, IReference<IResolvedTextEditorModel>> = {};

	// LRU cache for model references (keep last 100 models in memory for instant access)
	private readonly _modelCache: LRUCache<string, IReference<IResolvedTextEditorModel>> = new LRUCache(100);

	// Cache file existence checks (TTL: 5 seconds) to avoid redundant file system calls
	private readonly _fileExistenceCache: Map<string, { exists: boolean; timestamp: number }> = new Map();
	private static readonly FILE_EXISTENCE_CACHE_TTL_MS = 5000;

	constructor(
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		// Defense-in-depth for the existence cache: any external add/delete invalidates the cached
		// entry so a later initializeModel re-stats instead of trusting a stale value. The
		// deterministic fix is invalidateExistenceCache() at each create site (rewrite_file/edit_file);
		// this covers creates that don't route through there.
		this._register(this._fileService.onDidFilesChange(e => {
			if (this._fileExistenceCache.size === 0) { return; }
			for (const fsPath of [...this._fileExistenceCache.keys()]) {
				if (e.contains(URI.file(fsPath))) { this._fileExistenceCache.delete(fsPath); }
			}
		}));
	}

	saveModel = async (uri: URI) => {
		await this._textFileService.save(uri, { // we want [our change] -> [save] so it's all treated as one change.
			skipSaveParticipants: true // avoid triggering extensions etc (if they reformat the page, it will add another item to the undo stack)
		});
	};

	initializeModel = async (uri: URI) => {
		try {
			// Validate URI is actually a URI instance
			if (!uri || typeof uri.fsPath !== 'string') {
				vibeLog.debug('vibeideModel', 'InitializeModel error: Invalid URI provided', uri);
				return;
			}

			// Only process file:// URIs - skip other schemes like vscode-scm:, untitled:, etc.
			if (uri.scheme !== 'file') {
				return;
			}

			const fsPath = uri.fsPath;

			// Check cache first
			if (Object.hasOwn(this._modelRefOfURI, fsPath)) { return; }
			const cachedRef = this._modelCache.get(fsPath);
			if (cachedRef && !cachedRef.object.isDisposed()) {
				this._modelRefOfURI[fsPath] = cachedRef;
				return;
			}

			// Check file existence cache first (avoid redundant file system calls)
			const cachedExistence = this._fileExistenceCache.get(fsPath);
			const now = Date.now();
			let exists: boolean;

			if (cachedExistence && (now - cachedExistence.timestamp) < VibeideModelService.FILE_EXISTENCE_CACHE_TTL_MS) {
				exists = cachedExistence.exists;
			} else {
				// Resolve the path once and treat it as openable only when it exists AND is a file.
				// A directory passes a plain exists() check, then createModelReference reads it as
				// text and throws FileOperationError ("... is actually a directory") — the source of
				// the noisy InitializeModel error spam on .vibe/.cursor folders. A missing file is an
				// expected no-op. Both collapse to exists=false here.
				try {
					const stat = await this._fileService.stat(uri);
					exists = !stat.isDirectory;
				} catch (statErr) {
					if (isFileNotFoundError(statErr)) {
						exists = false;
					} else {
						throw statErr;
					}
				}
				this._fileExistenceCache.set(fsPath, { exists, timestamp: now });

				// Clean up old cache entries (keep cache size reasonable)
				if (this._fileExistenceCache.size > 1000) {
					const entriesToDelete: string[] = [];
					for (const [path, entry] of this._fileExistenceCache.entries()) {
						if (now - entry.timestamp > VibeideModelService.FILE_EXISTENCE_CACHE_TTL_MS) {
							entriesToDelete.push(path);
						}
					}
					for (const path of entriesToDelete) {
						this._fileExistenceCache.delete(path);
					}
				}
			}

			if (!exists) {
				return; // File doesn't exist, which is fine - just return silently
			}

			const editorModelRef = await this._textModelService.createModelReference(uri);
			// Keep a strong reference to prevent disposal
			this._modelRefOfURI[fsPath] = editorModelRef;
			// Also add to LRU cache
			this._modelCache.set(fsPath, editorModelRef);
		}
		catch (e) {
			// File-not-found is expected (model hallucinated a path) — don't log; the
			// existence cache above already records exists=false so repeats are cheap.
			if (isFileNotFoundError(e)) {
				return;
			}
			// Log other unexpected errors at debug level
			vibeLog.debug('vibeideModel', 'InitializeModel error:', e);
		}
	};

	getModelFromFsPath = (fsPath: string): VibeideModelType => {
		// Check primary cache first
		let editorModelRef = this._modelRefOfURI[fsPath];

		// If not in primary cache, check LRU cache
		if (!editorModelRef) {
			const cachedRef = this._modelCache.get(fsPath);
			if (cachedRef && !cachedRef.object.isDisposed()) {
				// Move to primary cache
				editorModelRef = cachedRef;
				this._modelRefOfURI[fsPath] = cachedRef;
			}
		}

		if (!editorModelRef) {
			return { model: null, editorModel: null };
		}

		const model = editorModelRef.object.textEditorModel;

		if (!model) {
			return { model: null, editorModel: editorModelRef.object };
		}

		return { model, editorModel: editorModelRef.object };
	};

	getModel = (uri: URI) => {
		return this.getModelFromFsPath(uri.fsPath);
	};


	getModelSafe = async (uri: URI): Promise<VibeideModelType> => {
		if (!Object.hasOwn(this._modelRefOfURI, uri.fsPath)) { await this.initializeModel(uri); }
		return this.getModel(uri);

	};

	// Drop the cached existence result for a path so the next initializeModel re-stats it. Call right
	// after creating a file: the cache may hold a stale `exists:false` taken before the create, which
	// would otherwise make initializeModel skip model resolution → instantlyRewriteFile no-op → empty
	// file saved as "success".
	invalidateExistenceCache = (uri: URI): void => {
		this._fileExistenceCache.delete(uri.fsPath);
	};

	override dispose() {
		super.dispose();
		for (const ref of Object.values(this._modelRefOfURI)) {
			ref.dispose(); // release reference to allow disposal
		}
		// Clear LRU cache (references will be disposed when evicted)
		this._modelCache.clear();
		this._fileExistenceCache.clear();
	}
}

registerSingleton(IVibeideModelService, VibeideModelService, InstantiationType.Eager);
