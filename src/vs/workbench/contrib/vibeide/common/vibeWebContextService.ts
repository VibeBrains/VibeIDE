/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { asText, IRequestService } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

export interface WebSearchResult {
	url: string;
	title: string;
	snippet: string;
}

export const IVibeWebContextService = createDecorator<IVibeWebContextService>('vibeWebContextService');

export interface IVibeWebContextService {
	readonly _serviceBrand: undefined;

	/**
	 * Search web and return results for LLM context.
	 * In privacy mode: requires explicit opt-in.
	 */
	search(query: string, isPrivacyMode: boolean): Promise<WebSearchResult[]>;

	/** Check if @web mention should show privacy warning */
	shouldWarnForPrivacyMode(isPrivacyMode: boolean): boolean;
}

/**
 * VibeIDE @web / @docs Context.
 * Provides web search results as LLM context.
 * In privacy mode: explicit opt-in with warning (search goes to external service).
 */
class VibeWebContextService extends Disposable implements IVibeWebContextService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IRequestService private readonly _requestService: IRequestService,
	) {
		super();
	}

	shouldWarnForPrivacyMode(isPrivacyMode: boolean): boolean {
		return isPrivacyMode; // Always warn in privacy mode
	}

	async search(query: string, isPrivacyMode: boolean): Promise<WebSearchResult[]> {
		if (isPrivacyMode) {
			vibeLog.warn('WebContext', '@web in privacy mode requires explicit opt-in. Query will be sent to search service.');
		}

		// Phase 1: use DuckDuckGo instant answers (no API key, privacy-respecting)
		// Phase 2: pluggable search providers (Bing, Google, Brave)
		try {
			const encodedQuery = encodeURIComponent(query);
			const context = await this._requestService.request({
				url: `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`,
				type: 'GET',
				callSite: 'vibeWebContextDDG',
			}, CancellationToken.None);

			const text = await asText(context);
			if (!text) { return []; }

			const data = JSON.parse(text);
			const results: WebSearchResult[] = [];

			// Abstract answer
			if (data.Abstract) {
				results.push({
					url: data.AbstractURL || '',
					title: data.Heading || query,
					snippet: data.Abstract,
				});
			}

			// Related topics
			if (Array.isArray(data.RelatedTopics)) {
				data.RelatedTopics.slice(0, 3).forEach((topic: Record<string, string>) => {
					if (topic.Text) {
						results.push({
							url: topic.FirstURL || '',
							title: topic.Text.split(' - ')[0] || '',
							snippet: topic.Text,
						});
					}
				});
			}

			vibeLog.debug('WebContext', `${results.length} results for: ${query}`);
			return results;
		} catch (e) {
			vibeLog.warn('WebContext', 'Search failed:', e);
			return [];
		}
	}
}

registerSingleton(IVibeWebContextService, VibeWebContextService, InstantiationType.Delayed);
