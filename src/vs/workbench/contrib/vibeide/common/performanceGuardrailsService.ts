/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

/**
 * Performance guardrails service for ensuring UI responsiveness
 */
export interface IPerformanceGuardrailsService {
	readonly _serviceBrand: undefined;

	/**
	 * Yield to the event loop to keep UI responsive
	 * @param timeoutMs Maximum time to wait before yielding (default: 50ms)
	 */
	yieldToEventLoop(timeoutMs?: number): Promise<void>;

	/**
	 * Process items in chunks with yielding between chunks
	 * @param items Array of items to process
	 * @param processor Function to process each item
	 * @param chunkSize Number of items to process before yielding
	 * @param token Cancellation token
	 */
	processInChunks<T, R>(
		items: T[],
		processor: (item: T, index: number) => Promise<R> | R,
		chunkSize: number,
		token?: CancellationToken
	): Promise<R[]>;

	/**
	 * Check if we should yield based on frame budget
	 * Returns true if we're approaching frame budget limits
	 */
	shouldYield(): boolean;

	/**
	 * Monitor frame budget and yield if needed
	 * @param startTime Performance.now() when operation started
	 * @param maxTimeMs Maximum time allowed before yielding
	 */
	checkFrameBudget(startTime: number, maxTimeMs?: number): boolean;
}

export const IPerformanceGuardrailsService = createDecorator<IPerformanceGuardrailsService>('performanceGuardrailsService');

/**
 * Maximum time before yielding for cancellation responsiveness
 */
const MAX_OPERATION_TIME_MS = 50; // Maximum time before yielding for cancellation responsiveness

export class PerformanceGuardrailsService implements IPerformanceGuardrailsService {
	declare readonly _serviceBrand: undefined;

	private _lastYieldTime: number = 0;
	private readonly YIELD_INTERVAL_MS = 50; // Yield at least every 50ms

	yieldToEventLoop(timeoutMs: number = 50): Promise<void> {
		return new Promise(resolve => {
			const now = performance.now();
			// If we've yielded recently, use a shorter timeout
			const timeSinceLastYield = now - this._lastYieldTime;
			const actualTimeout = Math.max(0, Math.min(timeoutMs, this.YIELD_INTERVAL_MS - timeSinceLastYield));

			if (typeof requestIdleCallback !== 'undefined') {
				requestIdleCallback(() => {
					this._lastYieldTime = performance.now();
					resolve();
				}, { timeout: actualTimeout });
			} else {
				setTimeout(() => {
					this._lastYieldTime = performance.now();
					resolve();
				}, actualTimeout);
			}
		});
	}

	async processInChunks<T, R>(
		items: T[],
		processor: (item: T, index: number) => Promise<R> | R,
		chunkSize: number,
		token?: CancellationToken
	): Promise<R[]> {
		const results: R[] = [];

		for (let i = 0; i < items.length; i += chunkSize) {
			// Check cancellation
			if (token?.isCancellationRequested) {
				throw new Error('Operation cancelled');
			}

			const chunk = items.slice(i, i + chunkSize);
			const chunkResults = await Promise.all(
				chunk.map((item, chunkIndex) => processor(item, i + chunkIndex))
			);
			results.push(...chunkResults);

			// Yield after each chunk (except the last one)
			if (i + chunkSize < items.length) {
				await this.yieldToEventLoop();
			}
		}

		return results;
	}

	shouldYield(): boolean {
		const now = performance.now();
		return (now - this._lastYieldTime) >= this.YIELD_INTERVAL_MS;
	}

	checkFrameBudget(startTime: number, maxTimeMs: number = MAX_OPERATION_TIME_MS): boolean {
		const elapsed = performance.now() - startTime;
		return elapsed >= maxTimeMs;
	}
}

registerSingleton(IPerformanceGuardrailsService, PerformanceGuardrailsService, InstantiationType.Delayed);

