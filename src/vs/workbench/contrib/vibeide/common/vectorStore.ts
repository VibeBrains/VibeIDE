/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface vector-store / RAG settings in VS Code's Settings UI. Without this
// block both keys read by `VectorStoreService` and the per-provider classes
// exist only via `||` fallbacks, so users never see them in the editor and
// can't switch from the built-in JS implementation to qdrant/chroma without
// editing settings.json by hand. Enum values must stay aligned with the
// `getValue<...>` literal type below.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.rag.vectorStore': {
			type: 'string',
			enum: ['built-in', 'none', 'qdrant', 'chroma'],
			enumDescriptions: [
				localize('vibeide.rag.vectorStore.builtIn', 'Встроенный JS-cosine vector store без внешних зависимостей. ~50k чанков; для большинства проектов достаточно. Рекомендуется.'),
				localize('vibeide.rag.vectorStore.none', 'Отключить semantic search полностью. Поиск работает только через `@search` (literal grep) и `@file`.'),
				localize('vibeide.rag.vectorStore.qdrant', 'Внешний Qdrant сервер. Требует поднятого инстанса (default URL `http://localhost:6333`); масштабируется на крупные monorepo.'),
				localize('vibeide.rag.vectorStore.chroma', 'Внешний Chroma сервер. Требует поднятого инстанса (default URL `http://localhost:8000`).'),
			],
			default: 'built-in',
			description: localize('vibeide.rag.vectorStore', 'Backend для semantic search / RAG. `built-in` (default) — JS cosine, без сетевых зависимостей; `qdrant`/`chroma` — внешние векторные БД для крупных проектов; `none` — полное отключение RAG-pipeline.'),
		},
		'vibeide.rag.vectorStoreUrl': {
			type: 'string',
			default: '',
			description: localize('vibeide.rag.vectorStoreUrl', 'Endpoint внешнего vector store (актуально только для `vectorStore: qdrant | chroma`). Пустая строка — использовать per-provider default (qdrant: `http://localhost:6333`, chroma: `http://localhost:8000`).'),
		},
	},
});

export interface VectorDocument {
	id: string; // Unique document ID (e.g., file path + chunk index)
	text: string; // Original text
	embedding: number[]; // Vector embedding
	metadata?: Record<string, unknown>; // Additional metadata (file path, line numbers, etc.)
}

export interface VectorSearchResult {
	id: string;
	text: string;
	score: number; // Similarity score (0-1, higher is better)
	metadata?: Record<string, unknown>;
}

/** Shape of a single point returned by Qdrant's `/points/search` endpoint. */
interface QdrantSearchPoint {
	id?: string | number;
	score?: number;
	payload?: Record<string, unknown>;
}

export const IVectorStore = createDecorator<IVectorStore>('vectorStore');

export interface IVectorStore {
	readonly _serviceBrand: undefined;
	isEnabled(): boolean;
	initialize(): Promise<void>;
	index(documents: VectorDocument[]): Promise<void>;
	query(queryEmbedding: number[], k: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]>;
	delete(ids: string[]): Promise<void>;
	clear(): Promise<void>;
}

/**
 * VibeIDE: Built-in in-process vector store using cosine similarity.
 * No external dependencies. Suitable for small-medium codebases (<10k chunks).
 * For larger codebases: configure vibeide.rag.vectorStore = 'qdrant'.
 */
class BuiltInVectorStore implements IVectorStore {
	declare readonly _serviceBrand: undefined;

	private readonly _documents = new Map<string, VectorDocument>();
	private readonly MAX_DOCUMENTS = 50_000;

	isEnabled(): boolean { return true; }

	async initialize(): Promise<void> {
		// No external setup needed
	}

	async index(documents: VectorDocument[]): Promise<void> {
		for (const doc of documents) {
			if (this._documents.size >= this.MAX_DOCUMENTS && !this._documents.has(doc.id)) {
				// Evict oldest document when limit reached
				const firstKey = this._documents.keys().next().value;
				if (firstKey) { this._documents.delete(firstKey); }
			}
			this._documents.set(doc.id, doc);
		}
	}

	async query(queryEmbedding: number[], k: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
		const results: VectorSearchResult[] = [];

		for (const doc of this._documents.values()) {
			// Apply metadata filter if provided
			if (filter && doc.metadata) {
				const matches = Object.entries(filter).every(([key, value]) => doc.metadata![key] === value);
				if (!matches) { continue; }
			}

			const score = this._cosineSimilarity(queryEmbedding, doc.embedding);
			results.push({ id: doc.id, text: doc.text, score, metadata: doc.metadata });
		}

		// Sort by score descending and return top-k
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, k);
	}

	async delete(ids: string[]): Promise<void> {
		for (const id of ids) {
			this._documents.delete(id);
		}
	}

	async clear(): Promise<void> {
		this._documents.clear();
	}

	private _cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length || a.length === 0) { return 0; }
		let dot = 0, magA = 0, magB = 0;
		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			magA += a[i] * a[i];
			magB += b[i] * b[i];
		}
		const denom = Math.sqrt(magA) * Math.sqrt(magB);
		return denom === 0 ? 0 : dot / denom;
	}
}

// No-op implementation (when vector store is disabled)
class NoOpVectorStore implements IVectorStore {
	declare readonly _serviceBrand: undefined;

	isEnabled(): boolean {
		return false;
	}

	async initialize(): Promise<void> {
		// No-op
	}

	async index(_documents: VectorDocument[]): Promise<void> {
		// No-op
	}

	async query(_queryEmbedding: number[], _k: number, _filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
		return [];
	}

	async delete(_ids: string[]): Promise<void> {
		// No-op
	}

	async clear(): Promise<void> {
		// No-op
	}
}

// Qdrant adapter
class QdrantVectorStore implements IVectorStore {
	declare readonly _serviceBrand: undefined;

	private _url: string;
	private _collectionName: string = 'vibeide_index';
	private _initialized = false;

	constructor(
		private readonly _configurationService: IConfigurationService,
		private readonly _logService: ILogService,
	) {
		this._url = this._configurationService.getValue<string>('vibeide.rag.vectorStoreUrl') || 'http://localhost:6333';
	}

	isEnabled(): boolean {
		return true;
	}

	async initialize(): Promise<void> {
		if (this._initialized) {
			return;
		}

		try {
			// Check if collection exists, create if not
			const checkResponse = await fetch(`${this._url}/collections/${this._collectionName}`);
			if (checkResponse.status === 404) {
				// Create collection
				await fetch(`${this._url}/collections/${this._collectionName}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						vectors: {
							size: 1536, // Default OpenAI embedding size, adjust if needed
							distance: 'Cosine',
						},
					}),
				});
			}
			this._initialized = true;
		} catch (error) {
			this._logService.error('[QdrantVectorStore] Failed to initialize:', error);
			throw error;
		}
	}

	async index(documents: VectorDocument[]): Promise<void> {
		if (!this._initialized) {
			await this.initialize();
		}

		try {
			// Batch upsert points
			const points = documents.map(doc => ({
				id: this._hashId(doc.id),
				vector: doc.embedding,
				payload: {
					text: doc.text,
					...doc.metadata,
				},
			}));

			// Qdrant supports batch upsert
			await fetch(`${this._url}/collections/${this._collectionName}/points`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ points }),
			});
		} catch (error) {
			this._logService.error('[QdrantVectorStore] Failed to index documents:', error);
			throw error;
		}
	}

	async query(queryEmbedding: number[], k: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
		if (!this._initialized) {
			await this.initialize();
		}

		try {
			const requestBody: {
				vector: number[];
				limit: number;
				with_payload: boolean;
				filter?: { must: { key: Record<string, unknown> }[] };
			} = {
				vector: queryEmbedding,
				limit: k,
				with_payload: true,
			};

			if (filter) {
				requestBody.filter = { must: Object.entries(filter).map(([key, value]) => ({ key: { [key]: value } })) };
			}

			const response = await fetch(`${this._url}/collections/${this._collectionName}/points/search`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody),
			});

			if (!response.ok) {
				throw new Error(`Qdrant query failed: ${response.statusText}`);
			}

			const data = await response.json() as { result?: QdrantSearchPoint[] };
			return (data.result || []).map(point => ({
				id: point.id?.toString() || '',
				text: typeof point.payload?.text === 'string' ? point.payload.text : '',
				score: point.score || 0,
				metadata: { ...point.payload, text: undefined }, // Exclude text from metadata
			}));
		} catch (error) {
			this._logService.error('[QdrantVectorStore] Failed to query:', error);
			return [];
		}
	}

	async delete(ids: string[]): Promise<void> {
		if (!this._initialized) {
			return;
		}

		try {
			const pointIds = ids.map(id => this._hashId(id));
			await fetch(`${this._url}/collections/${this._collectionName}/points/delete`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ points: pointIds }),
			});
		} catch (error) {
			this._logService.error('[QdrantVectorStore] Failed to delete:', error);
		}
	}

	async clear(): Promise<void> {
		if (!this._initialized) {
			return;
		}

		try {
			await fetch(`${this._url}/collections/${this._collectionName}`, {
				method: 'DELETE',
			});
			this._initialized = false;
		} catch (error) {
			this._logService.error('[QdrantVectorStore] Failed to clear:', error);
		}
	}

	private _hashId(id: string): number {
		// Simple hash function to convert string ID to number (Qdrant requires numeric IDs)
		let hash = 0;
		for (let i = 0; i < id.length; i++) {
			const char = id.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return Math.abs(hash);
	}
}

// Chroma adapter
class ChromaVectorStore implements IVectorStore {
	declare readonly _serviceBrand: undefined;

	private _url: string;
	private _collectionName: string = 'vibeide_index';
	private _initialized = false;

	constructor(
		private readonly _configurationService: IConfigurationService,
		private readonly _logService: ILogService,
	) {
		this._url = this._configurationService.getValue<string>('vibeide.rag.vectorStoreUrl') || 'http://localhost:8000';
	}

	isEnabled(): boolean {
		return true;
	}

	async initialize(): Promise<void> {
		if (this._initialized) {
			return;
		}

		try {
			// Check if collection exists, create if not
			const checkResponse = await fetch(`${this._url}/api/v1/collections/${this._collectionName}`);
			if (checkResponse.status === 404) {
				// Create collection
				await fetch(`${this._url}/api/v1/collections`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						name: this._collectionName,
						metadata: {},
					}),
				});
			}
			this._initialized = true;
		} catch (error) {
			this._logService.error('[ChromaVectorStore] Failed to initialize:', error);
			throw error;
		}
	}

	async index(documents: VectorDocument[]): Promise<void> {
		if (!this._initialized) {
			await this.initialize();
		}

		try {
			// Chroma uses upsert with ids, embeddings, documents, and metadatas
			const ids = documents.map(doc => doc.id);
			const embeddings = documents.map(doc => doc.embedding);
			const texts = documents.map(doc => doc.text);
			const metadatas = documents.map(doc => doc.metadata || {});

			await fetch(`${this._url}/api/v1/collections/${this._collectionName}/upsert`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					ids,
					embeddings,
					documents: texts,
					metadatas,
				}),
			});
		} catch (error) {
			this._logService.error('[ChromaVectorStore] Failed to index documents:', error);
			throw error;
		}
	}

	async query(queryEmbedding: number[], k: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
		if (!this._initialized) {
			await this.initialize();
		}

		try {
			const requestBody: {
				query_embeddings: number[][];
				n_results: number;
				include: string[];
				where?: Record<string, unknown>;
			} = {
				query_embeddings: [queryEmbedding],
				n_results: k,
				include: ['documents', 'metadatas', 'distances'],
			};

			if (filter) {
				requestBody.where = filter;
			}

			const response = await fetch(`${this._url}/api/v1/collections/${this._collectionName}/query`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody),
			});

			if (!response.ok) {
				throw new Error(`Chroma query failed: ${response.statusText}`);
			}

			const data = await response.json();
			const results: VectorSearchResult[] = [];

			if (data.ids && data.ids[0] && data.documents && data.documents[0]) {
				for (let i = 0; i < data.ids[0].length; i++) {
					results.push({
						id: data.ids[0][i],
						text: data.documents[0][i] || '',
						score: data.distances?.[0]?.[i] ? 1 - data.distances[0][i] : 0, // Convert distance to similarity
						metadata: data.metadatas?.[0]?.[i] || {},
					});
				}
			}

			return results;
		} catch (error) {
			this._logService.error('[ChromaVectorStore] Failed to query:', error);
			return [];
		}
	}

	async delete(ids: string[]): Promise<void> {
		if (!this._initialized) {
			return;
		}

		try {
			await fetch(`${this._url}/api/v1/collections/${this._collectionName}/delete`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids }),
			});
		} catch (error) {
			this._logService.error('[ChromaVectorStore] Failed to delete:', error);
		}
	}

	async clear(): Promise<void> {
		if (!this._initialized) {
			return;
		}

		try {
			await fetch(`${this._url}/api/v1/collections/${this._collectionName}`, {
				method: 'DELETE',
			});
			this._initialized = false;
		} catch (error) {
			this._logService.error('[ChromaVectorStore] Failed to clear:', error);
		}
	}
}

// Factory service
class VectorStoreService implements IVectorStore {
	declare readonly _serviceBrand: undefined;

	private _delegate: IVectorStore = new NoOpVectorStore();

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		this._updateDelegate();
		this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.rag')) {
				this._updateDelegate();
			}
		});
	}

	private _updateDelegate(): void {
		// VibeIDE: Default changed from 'none' to 'built-in' (in-process cosine similarity store)
		const provider = this._configurationService.getValue<'built-in' | 'none' | 'qdrant' | 'chroma'>('vibeide.rag.vectorStore') || 'built-in';

		switch (provider) {
			case 'built-in':
				this._delegate = new BuiltInVectorStore();
				break;
			case 'qdrant':
				this._delegate = new QdrantVectorStore(this._configurationService, this._logService);
				break;
			case 'chroma':
				this._delegate = new ChromaVectorStore(this._configurationService, this._logService);
				break;
			default:
				this._delegate = new NoOpVectorStore();
				break;
		}
	}

	isEnabled(): boolean {
		return this._delegate.isEnabled();
	}

	async initialize(): Promise<void> {
		await this._delegate.initialize();
	}

	async index(documents: VectorDocument[]): Promise<void> {
		await this._delegate.index(documents);
	}

	async query(queryEmbedding: number[], k: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
		return await this._delegate.query(queryEmbedding, k, filter);
	}

	async delete(ids: string[]): Promise<void> {
		await this._delegate.delete(ids);
	}

	async clear(): Promise<void> {
		await this._delegate.clear();
	}
}

registerSingleton(IVectorStore, VectorStoreService, InstantiationType.Delayed);

