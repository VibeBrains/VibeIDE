/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
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
	/** OpenRouter-style display literal e.g. "text->text" / "text+image->text" / "text+image+audio+video->text". Display-only. */
	modality?: string;
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

/** Result of validating a dynamic provider's key by probing its models endpoint. */
export type DynamicKeyValidation = { status: 'ok' | 'unauthorized' | 'error'; models: RemoteModelInfo[] };

/**
 * Service for fetching and caching remote provider model catalogs
 */
export interface IRemoteCatalogService {
	readonly _serviceBrand: undefined;

	/** Validate a dynamic provider's key by probing `modelsUrl` (or `<baseURL>/v1/models`): returns the
	 *  HTTP outcome (ok / unauthorized / error) plus the parsed model list on success. Used to gate
	 *  dynamic-provider models on a working key instead of mere key presence. */
	fetchDynamicWithStatus(baseURL: string, apiKey: string | undefined, modelsUrl?: string): Promise<DynamicKeyValidation>;

	/**
	 * Fetch models from a remote provider's catalog
	 */
	fetchCatalog(providerName: ProviderName, forceRefresh?: boolean): Promise<RemoteModelInfo[]>;

	/**
	 * Synchronous lookup against the already-cached catalog entries.
	 * Does NOT hit the network — returns `undefined` if no fetch has happened yet
	 * for this provider, or if the model id has no entry. Intended for hot paths
	 * (capability resolution at request prep time) where awaiting a fetch would
	 * stall the UI. The catalog is filled by `fetchCatalog` triggered from
	 * Settings UI / `refreshModelService` / first-run validation.
	 *
	 * Match strategy: case-insensitive against `id`, then `name`. Returns the
	 * first hit. No fuzzy/regex matching — keep this predictable.
	 */
	getCachedModelInfo(providerName: ProviderName, modelId: string): RemoteModelInfo | undefined;

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
	'openCodeGo',
	'minimax',
	'liteLLM',
	'lmRoute',
	'openAICompatible',
	'pollinations',
	'ollama',
	'vLLM',
	'lmStudio',
	'googleVertex',
	'microsoftAzure',
	'awsBedrock',
];

export class RemoteCatalogService implements IRemoteCatalogService {
	readonly _serviceBrand: undefined;

	private cache: Map<ProviderName, CachedCatalog> = new Map();
	private readonly DEFAULT_TTL = 3600_000; // 1 hour

	// Concurrent calls for the same provider share one promise — prevents fetch storms
	// when React re-renders or auto-polling and Settings effect both fire at once.
	private readonly inFlight = new Map<ProviderName, Promise<RemoteModelInfo[]>>();
	// Negative cache: after a failure/empty result, skip the network for this window.
	private readonly errorCooldownUntil = new Map<ProviderName, number>();
	private readonly ERROR_COOLDOWN_MS = 60_000;
	// Rate-limit identical error logs so a single unreachable provider can't drown the console.
	private readonly lastErrLogAt = new Map<ProviderName, number>();
	private readonly ERROR_LOG_INTERVAL_MS = 5 * 60_000;

	constructor(
		@IVibeideSettingsService private readonly settingsService: IVibeideSettingsService,
		@IRequestService private readonly requestService: IRequestService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) { }

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
				timeout: 10_000,
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

	getCachedModelInfo(providerName: ProviderName, modelId: string): RemoteModelInfo | undefined {
		const cached = this.cache.get(providerName);
		if (!cached) { return undefined; }
		// Allow lookups even after the TTL expires — capability resolution should
		// keep working between refreshes. The Settings UI is responsible for
		// triggering re-fetches; here we just expose what we have.
		const lc = modelId.toLowerCase();
		for (const m of cached.models) {
			if (typeof m.id === 'string' && m.id.toLowerCase() === lc) { return m; }
		}
		for (const m of cached.models) {
			if (typeof m.name === 'string' && m.name.toLowerCase() === lc) { return m; }
		}
		return undefined;
	}

	async fetchCatalog(providerName: ProviderName, forceRefresh: boolean = false): Promise<RemoteModelInfo[]> {
		// Check cache first
		if (!forceRefresh) {
			const cached = this.cache.get(providerName);
			if (cached && Date.now() - cached.timestamp < cached.ttl) {
				return cached.models;
			}
			// Negative cache — after a recent failure return [] immediately without hitting the network.
			const cooldownUntil = this.errorCooldownUntil.get(providerName);
			if (cooldownUntil && cooldownUntil > Date.now()) {
				return [];
			}
		}

		// Coalesce concurrent callers (React effect + auto-polling) onto a single fetch.
		const existing = this.inFlight.get(providerName);
		if (existing) {
			return existing;
		}

		const promise = (async (): Promise<RemoteModelInfo[]> => {
			try {
				const models = await this.fetchFromProvider(providerName);
				// Never cache empty results — avoids sticking on transient errors and clears stale catalogs when credentials were removed.
				if (models.length > 0) {
					this.cache.set(providerName, {
						models,
						timestamp: Date.now(),
						ttl: this.DEFAULT_TTL,
					});
					this.errorCooldownUntil.delete(providerName);
				} else {
					this.cache.delete(providerName);
					this.errorCooldownUntil.set(providerName, Date.now() + this.ERROR_COOLDOWN_MS);
				}
				return models;
			} finally {
				this.inFlight.delete(providerName);
			}
		})();

		this.inFlight.set(providerName, promise);
		return promise;
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
		return this.parseOpenAICompatibleModels(data);
	}

	private parseOpenAICompatibleModels(data: { data?: Record<string, unknown>[] }): RemoteModelInfo[] {
		return (data.data || []).map((model) => {
			// LiteLLM proxy and similar gateways extend OpenAI's /v1/models with capability fields.
			// Stock OpenAI/Mistral/Groq/etc. omit these — readers below tolerate undefined.
			const supportsVision = typeof (model as { supports_vision?: unknown }).supports_vision === 'boolean'
				? (model as { supports_vision: boolean }).supports_vision
				: undefined;
			const supportsPDF = typeof (model as { supports_pdf_input?: unknown }).supports_pdf_input === 'boolean'
				? (model as { supports_pdf_input: boolean }).supports_pdf_input
				: undefined;
			const pricing = (model as { input_cost_per_token?: unknown; output_cost_per_token?: unknown });
			const cost = typeof pricing.input_cost_per_token === 'number' || typeof pricing.output_cost_per_token === 'number'
				? {
					input: typeof pricing.input_cost_per_token === 'number' ? pricing.input_cost_per_token : 0,
					output: typeof pricing.output_cost_per_token === 'number' ? pricing.output_cost_per_token : 0,
				}
				: undefined;
			return {
				id: String(model.id ?? ''),
				name: String(model.id ?? model.name ?? ''),
				contextWindow: this.contextWindowFromOpenAICompatibleModel(model),
				supportsVision,
				supportsPDF,
				cost,
			};
		}).filter(m => m.id.length > 0);
	}

	async fetchDynamicWithStatus(baseURL: string, apiKey: string | undefined, modelsUrl?: string): Promise<DynamicKeyValidation> {
		const base = baseURL.replace(/\/+$/, '');
		const url = modelsUrl?.trim() ? modelsUrl.trim() : (base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`);
		const headers: IHeaders = {};
		if (apiKey?.trim()) { headers['Authorization'] = `Bearer ${apiKey.trim()}`; }
		try {
			// 'probe' (electron-main channel) returns the raw HTTP status without throwing on non-2xx, so
			// we can tell 401/403 (invalid key) apart from a network/server failure.
			const ipc = this.mainProcessService.getChannel('vibeide-channel-remoteCatalogFetch');
			const res = await ipc.call<{ status: number; body: string | null }>('probe', { url, headers });
			const status = res?.status ?? 0;
			if (status === 401 || status === 403) { return { status: 'unauthorized', models: [] }; }
			if (status >= 200 && status < 300 && typeof res?.body === 'string' && res.body.trim()) {
				try {
					const data = JSON.parse(res.body) as { data?: Record<string, unknown>[] };
					return { status: 'ok', models: this.parseOpenAICompatibleModels(data) };
				} catch {
					return { status: 'error', models: [] };
				}
			}
			return { status: 'error', models: [] };
		} catch {
			return { status: 'error', models: [] };
		}
	}

	private async fetchFromProvider(providerName: ProviderName): Promise<RemoteModelInfo[]> {
		// Dynamic providers (.vibe/providers.json) aren't in settingsOfProvider. Resolve their
		// baseURL + key from the transient transport overlay and fetch the standard OpenAI-compatible
		// /v1/models — same generic handler the built-in openai-compat providers use. No baseURL or no
		// key → nothing to fetch (the picker also hides keyless dynamic providers).
		const dyn = this.settingsService.getDynamicTransportConfigs()[providerName as unknown as string];
		if (dyn?.baseURL) {
			if (!dyn.apiKey?.trim()) {
				return [];
			}
			// `models.fetch: "<url>"` overrides the endpoint; otherwise derive it from baseURL.
			const base = dyn.baseURL.replace(/\/+$/, '');
			const modelsUrl = dyn.modelsUrl?.trim()
				? dyn.modelsUrl.trim()
				: (base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`);
			try {
				return await this.fetchOpenAICompatibleModelsCatalog(modelsUrl, dyn.apiKey);
			} catch (error) {
				const now = Date.now();
				const last = this.lastErrLogAt.get(providerName) ?? 0;
				if (now - last >= this.ERROR_LOG_INTERVAL_MS) {
					this.lastErrLogAt.set(providerName, now);
					vibeLog.warn('RemoteCatalog', `Failed to fetch catalog for dynamic provider ${String(providerName)}: ${error instanceof Error ? error.message : String(error)}`);
				}
				return [];
			}
		}

		const settings = this.settingsService.state.settingsOfProvider[providerName];

		if (!settings._didFillInProviderSettings) {
			return [];
		}

		const apiKey = (settings as { apiKey?: string }).apiKey;
		// Providers that don't authenticate via the apiKey field (local servers, OAuth-based,
		// proxy-fronted) — each case below validates whatever it actually needs.
		const allowsEmptyKey =
			providerName === 'openCodeZen'
			|| providerName === 'openCodeGo'
			|| providerName === 'openRouter'
			|| providerName === 'lmRoute'
			|| providerName === 'pollinations'
			|| providerName === 'ollama'
			|| providerName === 'vLLM'
			|| providerName === 'lmStudio'
			|| providerName === 'googleVertex'
			|| providerName === 'awsBedrock';

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
				case 'openCodeGo':
					return await this.fetchOpenAICompatibleModelsCatalog('https://opencode.ai/zen/go/v1/models', apiKey);
				case 'minimax':
					return await this.fetchOpenAICompatibleModelsCatalog('https://api.minimax.io/v1/models', apiKey);
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
				case 'lmRoute': {
					// LM Router: hosted at api.lmrouter.com/openai/v1 or self-hosted. The endpoint
					// already contains the version segment (/v1 or /openai/v1), so just append /models.
					const s = this.settingsService.state.settingsOfProvider.lmRoute;
					const ep = (s.endpoint || '').trim();
					if (!ep) {
						return [];
					}
					const modelsUrl = `${ep.replace(/\/$/, '')}/models`;
					return await this.fetchOpenAICompatibleModelsCatalog(modelsUrl, s.apiKey || undefined);
				}
				case 'vLLM': {
					const s = this.settingsService.state.settingsOfProvider.vLLM;
					const ep = (s.endpoint || '').trim();
					if (!ep) {
						return [];
					}
					const base = ep.replace(/\/$/, '');
					const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
					return await this.fetchOpenAICompatibleModelsCatalog(modelsUrl, undefined);
				}
				case 'lmStudio': {
					const s = this.settingsService.state.settingsOfProvider.lmStudio;
					const ep = (s.endpoint || '').trim();
					if (!ep) {
						return [];
					}
					const base = ep.replace(/\/$/, '');
					const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
					return await this.fetchOpenAICompatibleModelsCatalog(modelsUrl, undefined);
				}
				case 'ollama': {
					const s = this.settingsService.state.settingsOfProvider.ollama;
					const ep = (s.endpoint || '').trim();
					if (!ep) {
						return [];
					}
					return await this.fetchOllamaCatalog(ep);
				}
				case 'awsBedrock': {
					// Bedrock is exposed via an OpenAI-compatible proxy (LiteLLM default
					// http://localhost:4000/v1, or Bedrock-Access-Gateway). Native bedrock-runtime
					// is NOT OpenAI-compatible, so we never hit it from here.
					const s = this.settingsService.state.settingsOfProvider.awsBedrock;
					let baseURL = (s.endpoint || 'http://localhost:4000/v1').trim();
					if (!baseURL.endsWith('/v1')) {
						baseURL = baseURL.replace(/\/+$/, '') + '/v1';
					}
					return await this.fetchOpenAICompatibleModelsCatalog(`${baseURL}/models`, s.apiKey || undefined);
				}
				case 'googleVertex':
					return await this.fetchGoogleVertexCatalog();
				case 'microsoftAzure':
					return await this.fetchMicrosoftAzureCatalog();
				case 'pollinations':
					return await this.fetchPollinationsCatalog();
				default:
					return [];
			}
		} catch (error) {
			const now = Date.now();
			const last = this.lastErrLogAt.get(providerName) ?? 0;
			if (now - last >= this.ERROR_LOG_INTERVAL_MS) {
				this.lastErrLogAt.set(providerName, now);
				const msg = error instanceof Error ? error.message : String(error);
				vibeLog.warn('RemoteCatalog', `Failed to fetch catalog for ${providerName}: ${msg}`);
			}
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
			// OpenRouter's current schema is `architecture.input_modalities` (array of "text"|"image"|"audio"|"video"|"file").
			// Older snapshots used `modalities` — keep as legacy fallback so cached/older payloads still resolve.
			const arch = (model as { architecture?: { input_modalities?: string[]; output_modalities?: string[]; modalities?: string[]; modality?: string } }).architecture;
			const inputMods = arch?.input_modalities ?? arch?.modalities;
			const supportsVision = inputMods?.includes('image');
			const modality = typeof arch?.modality === 'string' && arch.modality.length > 0 ? arch.modality : undefined;
			return {
				id,
				name: nameStr,
				description: typeof (model as { description?: string }).description === 'string' ? (model as { description: string }).description : undefined,
				contextWindow: this.contextWindowFromOpenAICompatibleModel(model),
				supportsVision,
				supportsPDF: inputMods?.includes('file'),
				supportsCode: nameStr.toLowerCase().includes('code') || nameStr.toLowerCase().includes('coder'),
				modality,
				cost: (model as { pricing?: { prompt?: number; completion?: number } }).pricing ? {
					input: (model as { pricing: { prompt?: number } }).pricing.prompt || 0,
					output: (model as { pricing: { completion?: number } }).pricing.completion || 0,
				} : undefined,
				deprecated: !!(model as { deprecated?: boolean }).deprecated,
				beta: !!(model as { beta?: boolean }).beta,
			};
		}).filter(m => m.id.length > 0);
	}

	private async fetchOllamaCatalog(endpoint: string): Promise<RemoteModelInfo[]> {
		// Ollama returns { models: [{ name, model, modified_at, size, details: {...} }, ...] }
		const url = `${endpoint.replace(/\/$/, '')}/api/tags`;
		const data = await this.getJson<{ models?: Array<{ name?: string; model?: string }> }>(url, {}, 'ollamaTags');
		return (data.models || [])
			.map(m => {
				const id = String(m.name ?? m.model ?? '');
				return id ? { id, name: id } : null;
			})
			.filter((m): m is RemoteModelInfo => m !== null);
	}

	private async fetchPollinationsCatalog(): Promise<RemoteModelInfo[]> {
		// Pollinations exposes a public model list at https://text.pollinations.ai/models — JSON array.
		// Shape varies between releases; we accept a couple of common envelopes.
		try {
			const data = await this.getJson<object>('https://text.pollinations.ai/models', {}, 'pollinationsModels');
			const list: unknown[] = Array.isArray(data)
				? data
				: Array.isArray((data as { models?: unknown[] }).models)
					? (data as { models: unknown[] }).models
					: Array.isArray((data as { data?: unknown[] }).data)
						? (data as { data: unknown[] }).data
						: [];
			return list
				.map((m): RemoteModelInfo | null => {
					if (typeof m === 'string') {
						return { id: m, name: m };
					}
					if (m && typeof m === 'object') {
						const id = String((m as { name?: string; id?: string }).name ?? (m as { id?: string }).id ?? '');
						if (!id) {
							return null;
						}
						const description = (m as { description?: string }).description;
						return {
							id,
							name: id,
							description: typeof description === 'string' ? description : undefined,
						};
					}
					return null;
				})
				.filter((m): m is RemoteModelInfo => m !== null);
		} catch {
			return [];
		}
	}

	private async fetchGoogleVertexCatalog(): Promise<RemoteModelInfo[]> {
		const cfg = this.settingsService.state.settingsOfProvider.googleVertex;
		const region = (cfg.region || '').trim();
		const project = (cfg.project || '').trim();
		if (!region || !project) {
			return [];
		}
		// Get an OAuth2 access token from the main process (Application Default Credentials).
		let token: string;
		try {
			const ipc = this.mainProcessService.getChannel('vibeide-channel-remoteCatalogFetch');
			token = await ipc.call<string>('getGoogleAccessToken', undefined);
		} catch {
			return [];
		}
		// Vertex's OpenAI-compatible bridge mirrors /v1/models at the same baseURL used for chat
		// (see sendLLMMessage.impl.ts → googleVertex case).
		const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/endpoints/openapi/models`;
		try {
			return await this.fetchOpenAICompatibleModelsCatalog(url, token);
		} catch {
			return [];
		}
	}

	private async fetchMicrosoftAzureCatalog(): Promise<RemoteModelInfo[]> {
		const cfg = this.settingsService.state.settingsOfProvider.microsoftAzure;
		const resource = (cfg.project || '').trim(); // settings field is named `project` but holds the Azure resource name
		const apiKey = (cfg.apiKey || '').trim();
		const apiVersion = (cfg.azureApiVersion || '2024-04-01-preview').trim();
		if (!resource || !apiKey) {
			return [];
		}
		// Azure OpenAI lists *deployments* (user-deployed models) — that's what's actually callable.
		// Returns { data: [{ id: deploymentId, model: underlyingModelId, ... }, ...] }.
		const url = `https://${resource}.openai.azure.com/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`;
		const data = await this.getJson<{ data?: Array<{ id?: string; model?: string; status?: string }> }>(
			url,
			{ 'api-key': apiKey },
			'azureDeployments',
		);
		const out: RemoteModelInfo[] = [];
		for (const d of data.data || []) {
			const id = String(d.id ?? '');
			if (!id) {
				continue;
			}
			const model = typeof d.model === 'string' ? d.model : undefined;
			out.push({
				id,
				name: model ? `${id} (${model})` : id,
				description: model,
			});
		}
		return out;
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
		this.errorCooldownUntil.delete(providerName);
		this.lastErrLogAt.delete(providerName);
	}
}

export const IRemoteCatalogService = createDecorator<IRemoteCatalogService>('RemoteCatalogService');

registerSingleton(IRemoteCatalogService, RemoteCatalogService, InstantiationType.Delayed);

