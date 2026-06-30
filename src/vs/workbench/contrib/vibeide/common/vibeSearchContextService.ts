/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeIDE @search context (roadmap §K.3 / 932).
 *
 * Workspace literal grep — no LLM, no embeddings. Mirrors the shape of
 * `IVibeWebContextService` so the future mention→fragment dispatcher can
 * route `@search:foo` and `@web:foo` through the same surface.
 *
 * Pure rendering logic lives in `searchMentionResolver.ts` (validateSearchQuery
 * + renderSearchMentionFragment, unit-tested). This service is the thin
 * IDE-side wrapper that wires VS Code's `ISearchService` ripgrep backend
 * into that helper.
 */

import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { relative } from '../../../../base/common/path.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISearchService, resultIsMatch } from '../../../services/search/common/search.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { SearchHit, renderSearchMentionFragment, validateSearchQuery } from './searchMentionResolver.js';

export const IVibeSearchContextService = createDecorator<IVibeSearchContextService>('vibeSearchContextService');

export interface IVibeSearchContextService {
	readonly _serviceBrand: undefined;

	/**
	 * Run a literal workspace grep for `query` and return a markdown fragment
	 * suitable for LLM context injection. Empty/invalid queries return a short
	 * rejection markdown — never throw.
	 */
	searchAndRender(query: string): Promise<string>;
}

const MAX_RAW_HITS = 30;

class VibeSearchContextService extends Disposable implements IVibeSearchContextService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISearchService private readonly _searchService: ISearchService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}

	async searchAndRender(query: string): Promise<string> {
		const validated = validateSearchQuery(query);
		if (!validated.ok) {
			return `## @search rejected\n_reason: ${validated.reason}_`;
		}
		const folders = this._workspaceContextService.getWorkspace().folders.map(f => f.uri);
		if (folders.length === 0) {
			return renderSearchMentionFragment(validated.value, []);
		}

		try {
			const queryBuilder = this._instantiationService.createInstance(QueryBuilder);
			const textQuery = queryBuilder.text(
				{ pattern: validated.value, isRegExp: false },
				folders,
			);
			const data = await this._searchService.textSearch(textQuery, CancellationToken.None);

			const hits: SearchHit[] = [];
			const rootPath = folders[0].fsPath;
			outer: for (const fileMatch of data.results) {
				if (!fileMatch.results) {
					continue;
				}
				const rel = relative(rootPath, fileMatch.resource.fsPath).replace(/\\/g, '/');
				const filePath = rel.length > 0 && !rel.startsWith('..') ? rel : fileMatch.resource.fsPath;
				for (const r of fileMatch.results) {
					if (!resultIsMatch(r)) {
						continue;
					}
					const range = r.rangeLocations[0]?.source;
					if (!range) {
						continue;
					}
					hits.push({
						filePath,
						line: range.startLineNumber,
						column: range.startColumn,
						lineText: r.previewText,
					});
					if (hits.length >= MAX_RAW_HITS) {
						break outer;
					}
				}
			}

			return renderSearchMentionFragment(validated.value, hits);
		} catch (e) {
			vibeLog.warn('vibeSearchContext', '[VibeIDE @search] textSearch failed', e);
			return `## @search error\n_workspace search failed; see logs for details_`;
		}
	}
}

registerSingleton(IVibeSearchContextService, VibeSearchContextService, InstantiationType.Delayed);
