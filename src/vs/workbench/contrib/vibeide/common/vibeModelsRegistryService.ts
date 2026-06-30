/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	contextLength: number;
	trainingPolicy: 'none' | 'opt-in' | 'opt-out-available' | 'always';
	capabilities?: {
		functionCalling?: boolean;
		vision?: boolean;
		streaming?: boolean;
		extendedThinking?: boolean;
		structuredOutput?: boolean;
	};
}

export interface ModelsRegistry {
	version: string;
	updatedAt: string;
	models: ModelInfo[];
}

export const IVibeModelsRegistryService = createDecorator<IVibeModelsRegistryService>('vibeModelsRegistryService');

export interface IVibeModelsRegistryService {
	readonly _serviceBrand: undefined;

	/** Get current models registry (from cache or CDN) */
	getRegistry(): ModelsRegistry | null;

	/** Refresh registry from CDN (with ETag caching) */
	refresh(): Promise<void>;

	/** Get model info by ID */
	getModel(modelId: string): ModelInfo | undefined;

	/**
	 * Best-effort training data policy for the given chat model (from CDN registry).
	 * Returns undefined if unknown or offline with empty cache.
	 */
	getTrainingPolicyForSelection(providerName: string, modelName: string): ModelInfo['trainingPolicy'] | undefined;
}

// TODO: switch to https://registry.vibeide.io/models.json once DNS is live
const CDN_URL = 'https://raw.githubusercontent.com/VibeBrains/VibeIDE/main/resources/vibeide/models.json';
const CACHE_KEY = 'vibeide.modelsRegistry.cache';
const ETAG_KEY = 'vibeide.modelsRegistry.etag';

/**
 * VibeIDE Models Registry: loads models.json from CDN with ETag caching.
 * Falls back to local cache when offline.
 */
class VibeModelsRegistryService extends Disposable implements IVibeModelsRegistryService {
	declare readonly _serviceBrand: undefined;

	private _registry: ModelsRegistry | null = null;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();

		// Load from cache immediately (synchronous)
		const cached = this._storageService.get(CACHE_KEY, StorageScope.APPLICATION);
		if (cached) {
			try {
				this._registry = JSON.parse(cached) as ModelsRegistry;
				vibeLog.debug('ModelsRegistry', `Loaded ${this._registry.models?.length ?? 0} models from cache`);
			} catch {
				this._registry = null;
			}
		}

		// Refresh from CDN in background (non-blocking)
		this.refresh().catch(e => vibeLog.debug('ModelsRegistry', 'CDN refresh failed (offline?):', e));
	}

	getRegistry(): ModelsRegistry | null {
		return this._registry;
	}

	getModel(modelId: string): ModelInfo | undefined {
		return this._registry?.models.find(m => m.id === modelId);
	}

	getTrainingPolicyForSelection(providerName: string, modelName: string): ModelInfo['trainingPolicy'] | undefined {
		const models = this._registry?.models;
		if (!models?.length) {
			return undefined;
		}
		const want = modelName.trim().toLowerCase();
		if (!want) {
			return undefined;
		}
		for (const m of models) {
			const idTail = m.id.includes('/') ? m.id.split('/').pop()!.toLowerCase() : m.id.toLowerCase();
			if (m.name.toLowerCase() === want || idTail === want || m.id.toLowerCase().endsWith('/' + want)) {
				return m.trainingPolicy;
			}
		}
		return undefined;
	}

	async refresh(): Promise<void> {
		try {
			const etag = this._storageService.get(ETAG_KEY, StorageScope.APPLICATION);
			const headers: Record<string, string> = {
				'Accept': 'application/json',
				'User-Agent': 'VibeIDE/1.0',
			};
			if (etag) {
				headers['If-None-Match'] = etag;
			}

			const response = await fetch(CDN_URL, { headers });

			// 304 Not Modified — cache is still valid
			if (response.status === 304) {
				vibeLog.debug('ModelsRegistry', 'Cache still valid (304)');
				return;
			}

			if (!response.ok) {
				vibeLog.warn('ModelsRegistry', `CDN returned ${response.status}`);
				return;
			}

			const data = await response.json() as ModelsRegistry;
			const newEtag = response.headers.get('ETag');

			this._registry = data;
			this._storageService.store(CACHE_KEY, JSON.stringify(data), StorageScope.APPLICATION, StorageTarget.MACHINE);
			if (newEtag) {
				this._storageService.store(ETAG_KEY, newEtag, StorageScope.APPLICATION, StorageTarget.MACHINE);
			}

			vibeLog.info('ModelsRegistry', `Refreshed: ${data.models?.length ?? 0} models (v${data.version})`);
		} catch (e) {
			// Network error — use cached version silently
			vibeLog.debug('ModelsRegistry', 'Using cached registry (network unavailable)');
		}
	}
}

registerSingleton(IVibeModelsRegistryService, VibeModelsRegistryService, InstantiationType.Delayed);
