/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export interface ProviderCapabilities {
	modelId: string;
	providerName: string;
	probedAt: number;
	functionCalling: boolean;
	vision: boolean;
	streaming: boolean;
	extendedThinking: boolean;
	structuredOutput: boolean;
	nextEditPrediction: boolean;
	maxContextLength: number;
	toolExecutionMode: 'ptc' | 'parallel' | 'sequential';
}

export const IVibeProviderCapabilityService = createDecorator<IVibeProviderCapabilityService>('vibeProviderCapabilityService');

export interface IVibeProviderCapabilityService {
	readonly _serviceBrand: undefined;

	/** Get cached capabilities for a model (or probe if not cached) */
	getCapabilities(modelId: string, providerName: string): ProviderCapabilities;

	/** Record actual capabilities from first successful API call */
	recordCapabilities(caps: ProviderCapabilities): void;

	/** Check if a specific capability is supported */
	supports(modelId: string, capability: keyof Omit<ProviderCapabilities, 'modelId' | 'providerName' | 'probedAt' | 'maxContextLength' | 'toolExecutionMode'>): boolean;
}

const STORAGE_KEY = 'vibeide.providerCapabilities';

// Known capabilities table (Phase 1 heuristics — Phase 2: actual API probe)
const KNOWN_CAPABILITIES: Record<string, Partial<ProviderCapabilities>> = {
	'claude-3-5-sonnet': { functionCalling: true, vision: true, streaming: true, extendedThinking: true, structuredOutput: true, toolExecutionMode: 'ptc', maxContextLength: 200000 },
	'claude-3-5-haiku': { functionCalling: true, vision: true, streaming: true, extendedThinking: false, structuredOutput: true, toolExecutionMode: 'ptc', maxContextLength: 200000 },
	'gpt-4o': { functionCalling: true, vision: true, streaming: true, extendedThinking: false, structuredOutput: true, toolExecutionMode: 'parallel', maxContextLength: 128000 },
	'gpt-4o-mini': { functionCalling: true, vision: true, streaming: true, extendedThinking: false, structuredOutput: true, toolExecutionMode: 'parallel', maxContextLength: 128000 },
	'gemini-1.5-pro': { functionCalling: true, vision: true, streaming: true, extendedThinking: false, structuredOutput: true, toolExecutionMode: 'parallel', maxContextLength: 1000000 },
};

const DEFAULT_CAPS: Omit<ProviderCapabilities, 'modelId' | 'providerName' | 'probedAt'> = {
	functionCalling: false,
	vision: false,
	streaming: true,
	extendedThinking: false,
	structuredOutput: false,
	nextEditPrediction: false,
	maxContextLength: 4096,
	toolExecutionMode: 'sequential',
};

class VibeProviderCapabilityService extends Disposable implements IVibeProviderCapabilityService {
	declare readonly _serviceBrand: undefined;

	private readonly _cache = new Map<string, ProviderCapabilities>();

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._loadFromStorage();
	}

	private _loadFromStorage(): void {
		const stored = this._storageService.get(STORAGE_KEY, StorageScope.APPLICATION);
		if (stored) {
			try {
				const arr = JSON.parse(stored) as ProviderCapabilities[];
				arr.forEach(c => this._cache.set(`${c.providerName}:${c.modelId}`, c));
			} catch { /* ignore */ }
		}
	}

	getCapabilities(modelId: string, providerName: string): ProviderCapabilities {
		const key = `${providerName}:${modelId}`;
		if (this._cache.has(key)) {
			return this._cache.get(key)!;
		}

		// Heuristic lookup
		const known = Object.entries(KNOWN_CAPABILITIES).find(([k]) =>
			modelId.toLowerCase().includes(k)
		)?.[1] ?? {};

		const caps: ProviderCapabilities = {
			...DEFAULT_CAPS,
			...known,
			modelId,
			providerName,
			probedAt: Date.now(),
		};

		this._cache.set(key, caps);
		return caps;
	}

	recordCapabilities(caps: ProviderCapabilities): void {
		const key = `${caps.providerName}:${caps.modelId}`;
		this._cache.set(key, caps);
		const arr = Array.from(this._cache.values());
		this._storageService.store(STORAGE_KEY, JSON.stringify(arr), StorageScope.APPLICATION, StorageTarget.MACHINE);
		vibeLog.debug('ProviderCapability', `Recorded: ${caps.modelId} — thinking:${caps.extendedThinking}, vision:${caps.vision}, mode:${caps.toolExecutionMode}`);
	}

	supports(modelId: string, capability: keyof Omit<ProviderCapabilities, 'modelId' | 'providerName' | 'probedAt' | 'maxContextLength' | 'toolExecutionMode'>): boolean {
		const caps = this.getCapabilities(modelId, 'unknown');
		return caps[capability] as boolean ?? false;
	}
}

registerSingleton(IVibeProviderCapabilityService, VibeProviderCapabilityService, InstantiationType.Eager);
