/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Startup Performance Audit
 *
 * Measures cold/warm startup times, extension activation costs, memory usage, and CPU spikes
 */

export interface StartupMetrics {
	// Timing metrics
	coldStartTime: number; // Time from process start to ready (ms)
	warmStartTime: number; // Time from window open to ready (ms)
	extensionActivationTime: number; // Total time for extension activation (ms)
	initialMemoryMB: number; // Initial memory usage (MB)
	peakMemoryMB: number; // Peak memory during startup (MB)
	initialCPUPercent: number; // Initial CPU usage (%)
	peakCPUPercent: number; // Peak CPU during startup (%)

	// Phase timings
	willLoadExtensions: number; // Time to start loading extensions
	didLoadExtensions: number; // Time to finish loading extensions
	willActivateExtensions: number; // Time to start activating extensions
	didActivateExtensions: number; // Time to finish activating extensions
	readyToType: number; // Time until user can type (ms)

	// Extension details
	extensionCount: number;
	activatedExtensions: string[]; // List of activated extension IDs
	slowExtensions: Array<{ id: string; time: number }>; // Extensions taking >100ms

	timestamp: number;
}

class StartupAudit {
	private metrics: StartupMetrics | null = null;
	private startTime: number = 0;
	private extensionActivationTimes: Map<string, number> = new Map();
	private memorySamples: number[] = [];
	private cpuSamples: number[] = [];
	private performanceMarks: Map<string, number> = new Map();

	/**
	 * Start tracking startup
	 */
	start(): void {
		this.startTime = performance.now();
		this.memorySamples = [];
		this.cpuSamples = [];
		this.performanceMarks.clear();

		// Sample memory/CPU periodically during startup
		this.sampleResources();

		// Capture performance marks
		this.capturePerformanceMarks();
	}

	/**
	 * Mark a performance milestone
	 */
	mark(milestone: string): void {
		this.performanceMarks.set(milestone, performance.now());
	}

	/**
	 * Record extension activation time
	 */
	recordExtensionActivation(extensionId: string, time: number): void {
		this.extensionActivationTimes.set(extensionId, time);
	}

	/**
	 * Complete startup tracking and generate metrics
	 */
	complete(): StartupMetrics {
		const now = performance.now();
		const coldStartTime = this.startTime > 0 ? now - this.startTime : 0;

		// Calculate extension activation time
		let extensionActivationTime = 0;
		const slowExtensions: Array<{ id: string; time: number }> = [];
		for (const [id, time] of this.extensionActivationTimes) {
			extensionActivationTime += time;
			if (time > 100) {
				slowExtensions.push({ id, time });
			}
		}
		slowExtensions.sort((a, b) => b.time - a.time);

		// Calculate memory stats
		const initialMemory = this.memorySamples[0] || 0;
		const peakMemory = Math.max(...this.memorySamples, 0);

		// Calculate CPU stats
		const initialCPU = this.cpuSamples[0] || 0;
		const peakCPU = Math.max(...this.cpuSamples, 0);

		// Get performance marks
		const willLoadExtensions = this.performanceMarks.get('code/willLoadExtensions') || 0;
		const didLoadExtensions = this.performanceMarks.get('code/didLoadExtensions') || 0;
		const willActivateExtensions = this.performanceMarks.get('code/willActivateExtensions') || 0;
		const didActivateExtensions = this.performanceMarks.get('code/didActivateExtensions') || 0;

		// Estimate ready to type (when extensions are loaded and first editor is ready)
		const readyToType = didActivateExtensions || didLoadExtensions || now;

		// Warm start is from window open (if we can detect it)
		const warmStartTime = this.performanceMarks.get('code/didLoadWorkbenchMain')
			? (readyToType - (this.performanceMarks.get('code/didLoadWorkbenchMain') || 0))
			: 0;

		this.metrics = {
			coldStartTime,
			warmStartTime,
			extensionActivationTime,
			initialMemoryMB: initialMemory,
			peakMemoryMB: peakMemory,
			initialCPUPercent: initialCPU,
			peakCPUPercent: peakCPU,
			willLoadExtensions: willLoadExtensions - this.startTime,
			didLoadExtensions: didLoadExtensions - this.startTime,
			willActivateExtensions: willActivateExtensions - this.startTime,
			didActivateExtensions: didActivateExtensions - this.startTime,
			readyToType: readyToType - this.startTime,
			extensionCount: this.extensionActivationTimes.size,
			activatedExtensions: Array.from(this.extensionActivationTimes.keys()),
			slowExtensions: slowExtensions.slice(0, 10), // Top 10 slowest
			timestamp: Date.now(),
		};

		return this.metrics;
	}

	/**
	 * Get current metrics (may be incomplete)
	 */
	getMetrics(): StartupMetrics | null {
		return this.metrics;
	}

	/**
	 * Sample memory and CPU usage
	 */
	private sampleResources(): void {
		if (typeof performance !== 'undefined' && (performance as any).memory) {
			const memory = (performance as any).memory.usedJSHeapSize / 1024 / 1024; // MB
			this.memorySamples.push(memory);
		}

		// CPU sampling is approximate - we can't directly measure CPU in browser
		// But we can track long tasks
		if (typeof PerformanceObserver !== 'undefined') {
			try {
				const observer = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						if (entry.entryType === 'longtask') {
							const duration = entry.duration;
							// Approximate CPU usage (long task = high CPU)
							this.cpuSamples.push(Math.min(100, (duration / 50) * 100));
						}
					}
				});
				observer.observe({ entryTypes: ['longtask'] });
			} catch (e) {
				// PerformanceObserver not supported
			}
		}

		// Sample every 100ms for first 5 seconds
		let samples = 0;
		const interval = setInterval(() => {
			if (typeof performance !== 'undefined' && (performance as any).memory) {
				const memory = (performance as any).memory.usedJSHeapSize / 1024 / 1024;
				this.memorySamples.push(memory);
			}
			samples++;
			if (samples >= 50) { // 5 seconds
				clearInterval(interval);
			}
		}, 100);
	}

	/**
	 * Capture existing performance marks
	 */
	private capturePerformanceMarks(): void {
		if (typeof performance !== 'undefined' && performance.getEntriesByType) {
			const marks = performance.getEntriesByType('mark');
			for (const mark of marks) {
				this.performanceMarks.set(mark.name, mark.startTime);
			}
		}
	}
}

// Singleton instance
export const startupAudit = new StartupAudit();

// Auto-start on module load
if (typeof window !== 'undefined') {
	startupAudit.start();
}

