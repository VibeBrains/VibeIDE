/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
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
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	isReady(): boolean {
		return this._vectorStore.isEnabled();
	}

	async search(query: string, limit: number = 10): Promise<SemanticSearchResult[]> {
		if (!this.isReady()) {
			this._logService.warn('[VibeIDE SemanticSearch] Vector store not ready. Enable RAG in settings.');
			return [];
		}

		try {
			// Get query embedding — for Phase 1 use simple TF-IDF-like keyword matching
			// as embedding. Phase 2: use actual embedding model via Ollama/OpenAI.
			const queryEmbedding = vibeSimpleTextEmbedding(query);
			const results = await this._vectorStore.query(queryEmbedding, limit);

			return results.map(r => ({
				filePath: r.metadata?.filePath || r.id.split(':')[0],
				snippet: r.text.slice(0, 200),
				score: r.score,
				lineStart: r.metadata?.lineStart,
				lineEnd: r.metadata?.lineEnd,
			}));
		} catch (e) {
			this._logService.error('[VibeIDE SemanticSearch] Search failed:', e);
			return [];
		}
	}

}

registerSingleton(IVibeSemanticSearchService, VibeSemanticSearchService, InstantiationType.Delayed);
