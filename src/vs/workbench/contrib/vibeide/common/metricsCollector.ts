/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatLatencyMetrics } from './chatLatencyTypes.js';

/**
 * Global metrics collector for benchmarking
 */
export class MetricsCollector {
	private metrics: ChatLatencyMetrics[] = [];
	private readonly maxStored = 100; // Keep last 100 requests

	add(metrics: ChatLatencyMetrics): void {
		this.metrics.push(metrics);
		// Keep only recent metrics to avoid memory issues
		if (this.metrics.length > this.maxStored) {
			this.metrics.shift();
		}
	}

	getAll(): ChatLatencyMetrics[] {
		return [...this.metrics];
	}

	clear(): void {
		this.metrics = [];
	}
}

// Singleton instance
export const metricsCollector = new MetricsCollector();

