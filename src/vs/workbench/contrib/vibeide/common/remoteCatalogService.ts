/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import type { IHeaders } from '../../../../base/parts/request/common/request.js';
import { ProviderName } from './vibeideSettingsTypes.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IRequestService, asTextOrError } from '../../../../platform/request/common/request.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';

/**
 * Model information from remote provider catalogs
 */
export interface RemoteModelInfo {
	id: string;
	name: string;
	description?: string;
	contextWindow?: number;
	supportsVision?: boolean;
	supportsPDF?: boolean;
	supportsCode?: boolean;
	cost?: {
		input: number;
		output: number;
	};
	deprecated?: boolean;
	beta?: boolean;
	preview?: boolean;
}

/**
 * Cached catalog entry with TTL
 */
interface CachedCatalog {
	models: RemoteModelInfo[];
	timestamp: number;
	ttl: number; // milliseconds
}

/**
 * Service for fetching and caching remote provider model catalogs
 */
export interface IRemoteCatalogService {
	readonly _serviceBrand: undefined;

	/**
	 * Fetch models from a remote provider's catalog
	 */
	fetchCatalog(providerName: ProviderName, forceRefresh?: boolean): Promise<RemoteModelInfo[]>;

	/**
	 * Health check a specific model
	 */
	healthCheck(providerName: ProviderName, modelId: string): Promise<boolean>;

	/**
	 * Clear cache for a provider
	 */
	clearCache(providerName: ProviderName): void;
}

export const remoteCatalogCapableProviderNames: readonly ProviderName[] = [
	'openAI',
	'anthropic',
	'gemini',
	'mistral',
	'groq',
	'xAI',
	'deepseek',
	'openRouter',
	'openCodeZen',
	'openCode',
	'liteLLM',
	'openAICompatible',
	'pollinations',
];

export class RemoteCatalogService implements IRemoteCatalogService {
	readonly _serviceBrand: undefined;

	private cache: Map<ProviderName, CachedCatalog> = new Map();
	private readonly DEFAULT_TTL = 3600_000; // 1 hour

	constructor(
		@IVibeideSettingsService private readonly settingsService: IVibeideSettingsService,
		@IRequestService private readonly requestService: IRequestService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {}

	/**
	 * Workbench IRequestService uses `fetch()` (see requestImpl.ts) — CORS still blocks opencode.ai etc.
	 * Electron: prefer main-process Node IRequestService via IPC (`vibeide-channel-remoteCatalogFetch`).
	 */
	private async getJson<T extends object>(url: string, headers: IHeaders, callSiteSuffix: string): Promise<T> {
		let raw: string | null = null;

		try {
			const ipc = this.mainProcessService.getChannel('vibeide-channel-remoteCatalogFetch');
			raw = await ipc.call<string | null>('get', { url, headers });
		} catch {
			// Missing channel (non-Electron builds) — fall through
		}

		if (typeof raw !== 'string' || !raw.trim()) {
			const context = await this.requestService.request({
				type: 'GET',
				url,
				headers: {
					Accept: 'application/json',
					...headers,
				},
				timeout: 45_000,
				callSite: `vibeideRemoteCatalog.${callSiteSuffix}`,
			}, CancellationToken.None);
			raw = await asTextOrError(context);
		}

		if (typeof raw !== 'string' || !raw.trim()) {
			throw new Error('Empty catalog response');
		}

		let parsed: T;
		try {
			parsed = JSON.parse(raw) as T;
		} catch {
			throw new Error('Invalid JSON from catalog endpoint');
		}
		return parsed;
	}

	async fetchCatalog(providerName: ProviderName, forceRefresh: boolean = false): Promise<RemoteModelInfo[]> {
		// Check cache first
		if (!forceRefresh) {
			const cached = this.cache.get(providerName);
			if (cached && Date.now() - cached.timestamp < cached.ttl) {
				return cached.models;
			}
		}

		// Fetch from provider
		const models = await this.fetchFromProvider(providerName);

		// Never cache empty results — avoids sticking on transient errors and clears stale catalogs when credentials were removed.
		if (models.length > 0) {
			this.cache.set(providerName, {
				models,
				timestamp: Date.now(),
				ttl: this.DEFAULT_TTL,
			});
		} else {
			this.cache.delete(providerName);
		}

		return models;
	}

	/** Best-effort context limit from OpenAI-compatible /v1/models entries (OpenRouter, future Zen fields, etc.). */
	private contextWindowFromOpenAICompatibleModel(model: Record<string, unknown>): number | undefined {
		const candidates: unknown[] = [
			model.context_length,
			model.context_window,
			(model as { max_model_len?: unknown }).max_model_len,
			(model as { top_provider?: { context_length?: unknown } }).top_provider?.context_length,
			(model as { metadata?: { context_length?: unknown } }).metadata?.context_length,
		];
		for (const c of candidates) {
			if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
				return Math.floor(c);
			}
		}
		return undefined;
	}

	private async fetchOpenAICompatibleModelsCatalog(modelsUrl: string, apiKey: string | undefined): Promise<RemoteModelInfo[]> {
		const headers: IHeaders = {};
		if (apiKey?.trim()) {
			headers['Authorization'] = `Bearer ${apiKey.trim()}`;
		}
		const data = await this.getJson<{ data?: Record<string, unknown>[] }>(modelsUrl, headers, 'openaiCompatModels');
		return (data.data || []).map((model) => ({
			id: String(model.id ?? ''),
			name: String(model.id ?? model.name ?? ''),
			contextWindow: this.contextWindowFromOpenAICompatibleModel(model),
		})).filter(m => m.id.length > 0);
	}

	private async fetchFromProvider(providerName: ProviderName): Promise<RemoteModelInfo[]> {
		const settings = this.settingsService.state.settingsOfProvider[providerName];

		if (!settings._didFillInProviderSettings) {
			return [];
		}

		const apiKey = (settings as { apiKey?: string }).apiKey;
		const allowsEmptyKey =
			providerName === 'openCodeZen'
			|| providerName === 'openCode'
			|| providerName === 'openRouter';

		if (!apiKey?.trim() && !allowsEmptyKey) {
			return [];
		}

		try {
			switch (providerName) {
				case 'openAI':
					return await this.fetchOpenAICatalog(apiKey ?? '');
				case 'anthropic':
					return await this.fetchAnthropicCatalog(apiKey ?? '');
				case 'gemini':
					return await this.fetchGeminiCatalog(apiKey ?? '');
				case 'mistral':
					return await this.fetchMistralCatalog(apiKey ?? '');
				case 'groq':
					return await this.fetchGroqCatalog(apiKey ?? '');
				case 'xAI':
					return await this.fetchXAICatalog(apiKey ?? '');
				case 'deepseek':
					return await this.fetchDeepSeekCatalog(apiKey ?? '');
				case 'openRouter':
					return await this.fetchOpenRouterCatalog(apiKey);
				case 'openCodeZen':
					return await this.fetchOpenAICompatibleModelsCatalog('https://opencode.ai/zen/v1/models', apiKey);
				case 'openCode':
					return await this.fetchOpenAICompatibleModelsCatalog('https://opencode.ai/zen/go/v1/models', apiKey);
				case 'liteLLM': {
					const ep = (this.settingsService.state.settingsOfProvider.liteLLM.endpoint || '').trim();
					if (!ep) {
						return [];
					}
					const base = ep.replace(/\/$/, '');
					const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
					const k = (this.settingsService.state.settingsOfProvider.liteLLM as { apiKey?: string }).apiKey;
					return await this.fetchOpenAICompatibleModelsCatalog(modelsUrl, k || undefined);
				}
				case 'openAICompatible': {
					const s = this.settingsService.state.settingsOfProvider.openAICompatible;
					const ep = (s.endpoint || '').trim();
					if (!ep) {
						return [];
					}
					const base = ep.replace(/\/$/, '');
					const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
					return await this.fetchOpenAICompatibleModelsCatalog(modelsUrl, s.apiKey || undefined);
				}
				case 'pollinations':
					return [];
				default:
					return [];
			}
		} catch (error) {
			console.error(`Failed to fetch catalog for ${providerName}:`, error);
			return [];
		}
	}

	private async fetchOpenAICatalog(apiKey: string): Promise<RemoteModelInfo[]> {
		if (!apiKey?.trim()) {
			return [];
		}
		return this.fetchOpenAICompatibleModelsCatalog('https://api.openai.com/v1/models', apiKey);
	}

	private async fetchAnthropicCatalog(apiKey: string): Promise<RemoteModelInfo[]> {
		if (!apiKey?.trim()) {
			return [];
		}
		try {
			const data = await this.getJson<{ data?: { id: string }[] }>('https://api.anthropic.com/v1/models', {
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			}, 'anthropicModels');
			return (data.data || []).map(m => ({ id: m.id, name: m.id }));
		} catch {
			return [];
		}
	}

	private async fetchGeminiCatalog(apiKey: string): Promise<RemoteModelInfo[]> {
		if (!apiKey?.trim()) {
			return [];
		}
		try {
			const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
			const data = await this.getJson<{ models?: { name?: string; supportedGenerationMethods?: string[] }[] }>(url, {}, 'geminiModels');
			const out: RemoteModelInfo[] = [];
			for (const m of data.models || []) {
				const name = m.name || '';
				if (!name || !m.supportedGenerationMethods?.includes('generateContent')) {
					continue;
				}
				const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
				out.push({ id, name: id });
			}
			return out;
		} catch {
			return [];
		}
	}

	private async fetchMistralCatalog(apiKey: string): Promise<RemoteModelInfo[]> {
		if (!apiKey?.trim()) {
			return [];
		}
		return this.fetchOpenAICompatibleModelsCatalog('https://api.mistral.ai/v1/models', apiKey);
	}

	private async fetchGroqCatalog(apiKey: string): Promise<RemoteModelInfo[]> {
		if (!apiKey?.trim()) {
			return [];
		}
		return this.fetchOpenAICompatibleModelsCatalog('https://api.groq.com/openai/v1/models', apiKey);
	}

	private async fetchXAICatalog(apiKey: string): Promise<RemoteModelInfo[]> {
		if (!apiKey?.trim()) {
			return [];
		}
		return this.fetchOpenAICompatibleModelsCatalog('https://api.x.ai/v1/models', apiKey);
	}

	private async fetchDeepSeekCatalog(apiKey: string): Promise<RemoteModelInfo[]> {
		if (!apiKey?.trim()) {
			return [];
		}
		return this.fetchOpenAICompatibleModelsCatalog('https://api.deepseek.com/v1/models', apiKey);
	}

	private async fetchOpenRouterCatalog(apiKey: string | undefined): Promise<RemoteModelInfo[]> {
		const headers: IHeaders = {};
		if (apiKey?.trim()) {
			headers['Authorization'] = `Bearer ${apiKey.trim()}`;
		}
		const data = await this.getJson<{ data?: Record<string, unknown>[] }>('https://openrouter.ai/api/v1/models', headers, 'openRouter');
		return (data.data || []).map((model) => {
			const id = String(model.id ?? '');
			const nameStr = String((model as { name?: string }).name ?? id);
			const arch = (model as { architecture?: { modalities?: string[] } }).architecture;
			return {
				id,
				name: nameStr,
				description: typeof (model as { description?: string }).description === 'string' ? (model as { description: string }).description : undefined,
				contextWindow: this.contextWindowFromOpenAICompatibleModel(model),
				supportsVision: arch?.modalities?.includes('image'),
				supportsCode: nameStr.toLowerCase().includes('code') || nameStr.toLowerCase().includes('coder'),
				cost: (model as { pricing?: { prompt?: number; completion?: number } }).pricing ? {
					input: (model as { pricing: { prompt?: number } }).pricing.prompt || 0,
					output: (model as { pricing: { completion?: number } }).pricing.completion || 0,
				} : undefined,
				deprecated: !!(model as { deprecated?: boolean }).deprecated,
				beta: !!(model as { beta?: boolean }).beta,
			};
		}).filter(m => m.id.length > 0);
	}

	async healthCheck(providerName: ProviderName, modelId: string): Promise<boolean> {
		// Simple health check: try to make a minimal API call
		// This is a placeholder - actual implementation would vary by provider
		try {
			// For now, assume models are healthy if they're in the catalog
			const catalog = await this.fetchCatalog(providerName);
			return catalog.some(m => m.id === modelId && !m.deprecated);
		} catch {
			return false;
		}
	}

	clearCache(providerName: ProviderName): void {
		this.cache.delete(providerName);
	}
}

export const IRemoteCatalogService = createDecorator<IRemoteCatalogService>('RemoteCatalogService');

registerSingleton(IRemoteCatalogService, RemoteCatalogService, InstantiationType.Delayed);

