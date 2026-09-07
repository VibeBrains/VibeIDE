/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	blendImageCost, DEFAULT_IMAGE_TOKENS, imageCostKey, inferImageCost,
} from '../common/imageTokenCost.js';
import { vibeLog } from '../common/vibeLog.js';

/**
 * Что мы знаем о цене изображения у каждой модели.
 *
 * Learned rather than configured: nobody can be expected to know that their local vision model
 * charges four thousand tokens for a screenshot while a cloud one charges eleven hundred — but the
 * provider says so itself, in `usage`, on every request that carries an image.
 *
 * Remembered per model at a host and across sessions: the price does not change between runs, and
 * re-learning it every launch would leave the first screenshots of every session mispriced.
 */

export const IVibeImageCostService = createDecorator<IVibeImageCostService>('vibeImageCostService');

export interface IVibeImageCostService {
	readonly _serviceBrand: undefined;
	/** Tokens one image costs at this model — the learned value, or the safe default. */
	costFor(providerName: string, modelName: string): number;
	/**
	 * Record what a request actually cost, so the next estimate is closer.
	 *
	 * Called with the provider's own `prompt_tokens` and our count of the text and images we sent.
	 */
	observe(providerName: string, modelName: string, observation: { promptTokens: number; textTokens: number; images: number }): void;
}

const STORAGE_KEY = 'vibeide.imageTokenCosts';

class VibeImageCostService extends Disposable implements IVibeImageCostService {

	declare readonly _serviceBrand: undefined;

	private readonly _costs = new Map<string, number>();
	/** Last request per model, against which the next one is compared. */
	private readonly _anchors = new Map<string, { promptTokens: number; textTokens: number; images: number }>();

	constructor(
		@IStorageService private readonly _storage: IStorageService,
	) {
		super();
		try {
			const raw = this._storage.get(STORAGE_KEY, StorageScope.PROFILE, '{}');
			for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
				if (typeof value === 'number' && value > 0) {
					this._costs.set(key, value);
				}
			}
		} catch {
			// A corrupted store costs us the learned prices, not the session: defaults still work.
			vibeLog.warn('imageCost', 'сохранённые цены изображений нечитаемы — начинаю заново');
		}
	}

	costFor(providerName: string, modelName: string): number {
		return this._costs.get(imageCostKey(providerName, modelName)) ?? DEFAULT_IMAGE_TOKENS;
	}

	observe(providerName: string, modelName: string, observation: { promptTokens: number; textTokens: number; images: number }): void {
		const key = imageCostKey(providerName, modelName);
		const anchor = this._anchors.get(key);
		// The anchor is replaced on every request, image or not: the next measurement is only
		// meaningful against the request immediately before it.
		this._anchors.set(key, observation);
		if (!anchor) {
			return;
		}
		const measured = inferImageCost(anchor, observation);
		if (measured === undefined) {
			return;
		}
		const blended = blendImageCost(this._costs.get(key), measured);
		this._costs.set(key, blended);
		vibeLog.debug('imageCost', `цена изображения ${key}: измерено ${Math.round(measured)}, принято ${blended}`);
		this._persist();
	}

	private _persist(): void {
		this._storage.store(STORAGE_KEY, JSON.stringify(Object.fromEntries(this._costs)), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}

registerSingleton(IVibeImageCostService, VibeImageCostService, InstantiationType.Delayed);
