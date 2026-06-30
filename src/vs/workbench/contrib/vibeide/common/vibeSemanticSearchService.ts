/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IVectorStore } from './vectorStore.js';
import { vibeSimpleTextEmbedding } from './vibeSimpleEmbedding.js';

export interface SemanticSearchResult {
	filePath: string;
	snippet: string;
	score: number;
	lineStart?: number;
	lineEnd?: number;
}

export const IVibeSemanticSearchService = createDecorator<IVibeSemanticSearchService>('vibeSemanticSearchService');

export interface IVibeSemanticSearchService {
	readonly _serviceBrand: undefined;

	/**
	 * Natural language search through codebase via vectorStore.ts + RAG.
	 * Example: «найди где обрабатывается авторизация»
	 */
	search(query: string, limit?: number): Promise<SemanticSearchResult[]>;

	/** Check if search index is ready */
	isReady(): boolean;
}

/**
 * VibeIDE Semantic Codebase Search: natural language search via RAG.
 * Uses BuiltInVectorStore + repoIndexerService for embeddings.
 */
class VibeSemanticSearchService extends Disposable implements IVibeSemanticSearchService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IVectorStore private readonly _vectorStore: IVectorStore,
	) {
		super();
	}

	isReady(): boolean {
		return this._vectorStore.isEnabled();
	}

	async search(query: string, limit: number = 10): Promise<SemanticSearchResult[]> {
		if (!this.isReady()) {
			vibeLog.warn('SemanticSearch', 'Vector store not ready. Enable RAG in settings.');
			return [];
		}

		try {
			// Get query embedding — for Phase 1 use simple TF-IDF-like keyword matching
			// as embedding. Phase 2: use actual embedding model via Ollama/OpenAI.
			const queryEmbedding = vibeSimpleTextEmbedding(query);
			const results = await this._vectorStore.query(queryEmbedding, limit);

			return results.map(r => ({
				filePath: (r.metadata?.filePath as string | undefined) || r.id.split(':')[0],
				snippet: r.text.slice(0, 200),
				score: r.score,
				lineStart: r.metadata?.lineStart as number | undefined,
				lineEnd: r.metadata?.lineEnd as number | undefined,
			}));
		} catch (e) {
			vibeLog.error('SemanticSearch', 'Search failed:', e);
			return [];
		}
	}

}

registerSingleton(IVibeSemanticSearchService, VibeSemanticSearchService, InstantiationType.Delayed);
