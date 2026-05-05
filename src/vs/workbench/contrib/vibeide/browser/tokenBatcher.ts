/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Token Batcher for smooth 60 FPS streaming updates
 *
 * Batches token updates using requestAnimationFrame to ensure smooth rendering
 * without blocking the UI thread.
 */

export interface BatchedUpdate {
	fullText: string;
	fullReasoning: string;
	toolCall?: any;
}

export type TokenUpdateCallback = (update: BatchedUpdate) => void;

export class TokenBatcher {
	private _pendingUpdate: BatchedUpdate | null = null;
	private _rafId: number | null = null;
	private _batchSizes: number[] = [];
	private _currentBatchSize: number = 0;

	constructor(
		private readonly _callback: TokenUpdateCallback,
	) {
	}

	/**
	 * Add a token update to the batch
	 */
	addUpdate(update: BatchedUpdate): void {
		this._pendingUpdate = update;
		this._currentBatchSize++;

		// Schedule batch flush if not already scheduled
		if (this._rafId === null) {
			this._rafId = requestAnimationFrame(() => this._flush());
		}
	}

	/**
	 * Flush pending updates immediately
	 */
	flush(): void {
		if (this._rafId !== null) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}
		this._flush();
	}

	private _flush(): void {
		this._rafId = null;

		if (this._pendingUpdate) {
			// Record batch size
			if (this._currentBatchSize > 0) {
				this._batchSizes.push(this._currentBatchSize);
				// Keep only last 100 batch sizes
				if (this._batchSizes.length > 100) {
					this._batchSizes.shift();
				}
			}

			// Call callback with latest update
			this._callback(this._pendingUpdate);

			// Clear pending update
			this._pendingUpdate = null;
			this._currentBatchSize = 0;
		}
	}

	/**
	 * Get average batch size
	 */
	getAverageBatchSize(): number {
		if (this._batchSizes.length === 0) {
			return 0;
		}
		return this._batchSizes.reduce((a, b) => a + b, 0) / this._batchSizes.length;
	}

	/**
	 * Dispose and clean up
	 */
	dispose(): void {
		if (this._rafId !== null) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}
		this._pendingUpdate = null;
		this._batchSizes = [];
	}
}

