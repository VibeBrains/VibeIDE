/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ProviderName } from './vibeideSettingsTypes.js';

// Реализация — `electron-browser/remoteCatalogService.ts`: класс ходит в main-процесс за сетевыми
// запросами через `IMainProcessService` (канал `vibeide-channel-remoteCatalogFetch`, три обращения
// в разных методах), а этот тип запрещён и в `common/**`, и в `browser/**`. Контракт остаётся здесь:
// его берут `browser/vibeDynamicProvidersService.ts` И `common/refreshModelService.ts` — второй
// живёт в common, поэтому контракт не может уехать даже в browser.

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

export const IRemoteCatalogService = createDecorator<IRemoteCatalogService>('RemoteCatalogService');
