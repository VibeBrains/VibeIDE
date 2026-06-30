/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Performance Harness for VibeIDE
 *
 * Measures and reports key performance metrics:
 * - Render metrics: framesDropped, avgBatchMs, maxBatchMs
 * - Chat pipeline: onPrompt, modelStart, firstToken, lastToken, renderComplete
 * - Autocomplete: provider resolve time, total time
 * - Indexer: filesPerSec, avgParseMs, cpuBudgetHit
 * - Router: route decision time
 *
 * All metrics stored in ring buffers to avoid memory issues.
 * Zero overhead when disabled.
 */

export interface RenderMetric {
	timestamp: number;
	requestId: string;
	batchSize: number;
	batchMs: number;
	framesDropped: number;
}

export type ChatCheckpoint = 'onPrompt' | 'modelStart' | 'firstToken' | 'lastToken' | 'renderComplete';

export interface ChatMetric {
	timestamp: number;
	requestId: string;
	checkpoint: ChatCheckpoint;
	elapsedMs: number;
}

export interface AutocompleteMetric {
	timestamp: number;
	providerTime: number;
	totalTime: number;
	cacheHit: boolean;
}

export interface IndexerMetric {
	timestamp: number;
	filesPerSec: number;
	avgParseMs: number;
	cpuBudgetHit: boolean;
}

export interface RouterMetric {
	timestamp: number;
	decisionTime: number;
	cacheHit: boolean;
}

export interface PerformanceReport {
	render: {
		avgBatchMs: number;
		maxBatchMs: number;
		p95FramesDropped: number;
		totalFrames: number;
	};
	chat: {
		p50TTFS: number;
		p95TTFS: number;
		p50TTS: number;
		p95TTS: number;
	};
	autocomplete: {
		p95ProviderTime: number;
		p95TotalTime: number;
		cacheHitRate: number;
	};
	indexer: {
		avgFilesPerSec: number;
		avgParseMs: number;
		cpuBudgetHitRate: number;
	};
	router: {
		p95DecisionTime: number;
		cacheHitRate: number;
	};
}

/**
 * Ring buffer for storing metrics (fixed size, O(1) operations)
 */
class RingBuffer<T> {
	private buffer: (T | undefined)[];
	private head: number = 0;
	private size: number = 0;
	private readonly capacity: number;

	constructor(capacity: number) {
		this.capacity = capacity;
		this.buffer = new Array(capacity);
	}

	push(item: T): void {
		this.buffer[this.head] = item;
		this.head = (this.head + 1) % this.capacity;
		if (this.size < this.capacity) {
			this.size++;
		}
	}

	getAll(): T[] {
		const result: T[] = [];
		for (let i = 0; i < this.size; i++) {
			const idx = (this.head - this.size + i + this.capacity) % this.capacity;
			const item = this.buffer[idx];
			if (item !== undefined) {
				result.push(item);
			}
		}
		return result;
	}

	clear(): void {
		this.buffer = new Array(this.capacity);
		this.head = 0;
		this.size = 0;
	}

	get length(): number {
		return this.size;
	}
}

export class PerformanceHarness {
	private readonly enabled: boolean;
	private readonly renderMetrics: RingBuffer<RenderMetric>;
	private readonly chatMetrics: RingBuffer<ChatMetric>;
	private readonly autocompleteMetrics: RingBuffer<AutocompleteMetric>;
	private readonly indexerMetrics: RingBuffer<IndexerMetric>;
	private readonly routerMetrics: RingBuffer<RouterMetric>;

	// Chat request tracking. Map preserves insertion order; we treat it as an LRU and
	// evict oldest entries when size exceeds MAX_TRACKED_CHAT_REQUESTS. Without the cap
	// the Map grew unbounded across the session (entries only released in `clear()` on
	// dispose) — measurable hold on long agentic flows.
	private static readonly MAX_TRACKED_CHAT_REQUESTS = 500;
	private readonly chatRequests: Map<string, {
		onPrompt?: number;
		modelStart?: number;
		firstToken?: number;
		lastToken?: number;
		renderComplete?: number;
	}> = new Map();

	constructor(enabled: boolean = false) {
		this.enabled = enabled;
		this.renderMetrics = new RingBuffer<RenderMetric>(1000);
		this.chatMetrics = new RingBuffer<ChatMetric>(1000);
		this.autocompleteMetrics = new RingBuffer<AutocompleteMetric>(1000);
		this.indexerMetrics = new RingBuffer<IndexerMetric>(1000);
		this.routerMetrics = new RingBuffer<RouterMetric>(1000);
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Record a render frame with batch information
	 */
	recordRenderFrame(requestId: string, batchSize: number, batchMs: number, framesDropped: number = 0): void {
		if (!this.enabled) { return; }

		// Use microtask to avoid blocking UI thread
		Promise.resolve().then(() => {
			this.renderMetrics.push({
				timestamp: performance.now(),
				requestId,
				batchSize,
				batchMs,
				framesDropped,
			});
		});
	}

	/**
	 * Record a chat pipeline checkpoint
	 */
	recordChatCheckpoint(requestId: string, checkpoint: ChatCheckpoint, timestamp?: number): void {
		if (!this.enabled) { return; }

		const now = timestamp ?? performance.now();
		const request = this.chatRequests.get(requestId) ?? {};

		// Update request state
		request[checkpoint] = now;
		this.chatRequests.set(requestId, request);

		// LRU eviction: if we just pushed the entry past the cap, drop the oldest one.
		// Map preserves insertion order; reassigning an existing key does NOT change order,
		// so an active updating request stays at its original position — that's fine since
		// total churn is bounded by MAX_TRACKED_CHAT_REQUESTS.
		if (this.chatRequests.size > PerformanceHarness.MAX_TRACKED_CHAT_REQUESTS) {
			const oldestKey = this.chatRequests.keys().next().value;
			if (oldestKey !== undefined) { this.chatRequests.delete(oldestKey); }
		}

		// Calculate elapsed time from onPrompt
		const elapsedMs = request.onPrompt ? now - request.onPrompt : 0;

		// Use microtask to avoid blocking UI thread
		Promise.resolve().then(() => {
			this.chatMetrics.push({
				timestamp: now,
				requestId,
				checkpoint,
				elapsedMs,
			});
		});
	}

	/**
	 * Record autocomplete metrics
	 */
	recordAutocomplete(providerTime: number, totalTime: number, cacheHit: boolean = false): void {
		if (!this.enabled) { return; }

		// Use microtask to avoid blocking UI thread
		Promise.resolve().then(() => {
			this.autocompleteMetrics.push({
				timestamp: performance.now(),
				providerTime,
				totalTime,
				cacheHit,
			});
		});
	}

	/**
	 * Record indexer metrics
	 */
	recordIndexer(filesPerSec: number, avgParseMs: number, cpuBudgetHit: boolean = false): void {
		if (!this.enabled) { return; }

		// Use microtask to avoid blocking UI thread
		Promise.resolve().then(() => {
			this.indexerMetrics.push({
				timestamp: performance.now(),
				filesPerSec,
				avgParseMs,
				cpuBudgetHit,
			});
		});
	}

	/**
	 * Record router metrics
	 */
	recordRouter(decisionTime: number, cacheHit: boolean = false): void {
		if (!this.enabled) { return; }

		// Use microtask to avoid blocking UI thread
		Promise.resolve().then(() => {
			this.routerMetrics.push({
				timestamp: performance.now(),
				decisionTime,
				cacheHit,
			});
		});
	}

	/**
	 * Get performance report with percentiles
	 */
	getReport(): PerformanceReport {
		const renderAll = this.renderMetrics.getAll();
		const chatAll = this.chatMetrics.getAll();
		const autocompleteAll = this.autocompleteMetrics.getAll();
		const indexerAll = this.indexerMetrics.getAll();
		const routerAll = this.routerMetrics.getAll();

		// Calculate percentiles helper
		const percentile = (values: number[], p: number): number => {
			if (values.length === 0) { return 0; }
			const sorted = [...values].sort((a, b) => a - b);
			const index = Math.floor(sorted.length * p);
			return sorted[index] ?? 0;
		};

		// Render metrics
		const batchTimes = renderAll.map(m => m.batchMs);
		const framesDropped = renderAll.map(m => m.framesDropped);
		const render = {
			avgBatchMs: batchTimes.length > 0 ? batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length : 0,
			maxBatchMs: batchTimes.length > 0 ? Math.max(...batchTimes) : 0,
			p95FramesDropped: percentile(framesDropped, 0.95),
			totalFrames: renderAll.length,
		};

		// Chat metrics (TTFS = firstToken - onPrompt, TTS = lastToken - onPrompt)
		const ttfsValues: number[] = [];
		const ttsValues: number[] = [];
		const requestMap = new Map<string, { onPrompt?: number; firstToken?: number; lastToken?: number }>();

		for (const metric of chatAll) {
			const req = requestMap.get(metric.requestId) ?? {};
			if (metric.checkpoint === 'onPrompt') { req.onPrompt = metric.elapsedMs === 0 ? metric.timestamp : undefined; }
			if (metric.checkpoint === 'firstToken') { req.firstToken = metric.timestamp; }
			if (metric.checkpoint === 'lastToken') { req.lastToken = metric.timestamp; }
			requestMap.set(metric.requestId, req);
		}

		for (const req of requestMap.values()) {
			if (req.onPrompt && req.firstToken) {
				ttfsValues.push(req.firstToken - req.onPrompt);
			}
			if (req.onPrompt && req.lastToken) {
				ttsValues.push(req.lastToken - req.onPrompt);
			}
		}

		const chat = {
			p50TTFS: percentile(ttfsValues, 0.5),
			p95TTFS: percentile(ttfsValues, 0.95),
			p50TTS: percentile(ttsValues, 0.5),
			p95TTS: percentile(ttsValues, 0.95),
		};

		// Autocomplete metrics
		const providerTimes = autocompleteAll.map(m => m.providerTime);
		const totalTimes = autocompleteAll.map(m => m.totalTime);
		const cacheHits = autocompleteAll.filter(m => m.cacheHit).length;
		const autocomplete = {
			p95ProviderTime: percentile(providerTimes, 0.95),
			p95TotalTime: percentile(totalTimes, 0.95),
			cacheHitRate: autocompleteAll.length > 0 ? cacheHits / autocompleteAll.length : 0,
		};

		// Indexer metrics
		const filesPerSec = indexerAll.map(m => m.filesPerSec);
		const parseTimes = indexerAll.map(m => m.avgParseMs);
		const cpuBudgetHits = indexerAll.filter(m => m.cpuBudgetHit).length;
		const indexer = {
			avgFilesPerSec: filesPerSec.length > 0 ? filesPerSec.reduce((a, b) => a + b, 0) / filesPerSec.length : 0,
			avgParseMs: parseTimes.length > 0 ? parseTimes.reduce((a, b) => a + b, 0) / parseTimes.length : 0,
			cpuBudgetHitRate: indexerAll.length > 0 ? cpuBudgetHits / indexerAll.length : 0,
		};

		// Router metrics
		const decisionTimes = routerAll.map(m => m.decisionTime);
		const routerCacheHits = routerAll.filter(m => m.cacheHit).length;
		const router = {
			p95DecisionTime: percentile(decisionTimes, 0.95),
			cacheHitRate: routerAll.length > 0 ? routerCacheHits / routerAll.length : 0,
		};

		return {
			render,
			chat,
			autocomplete,
			indexer,
			router,
		};
	}

	/**
	 * Export metrics as JSONL string
	 */
	exportJSONL(): string {
		const lines: string[] = [];

		for (const metric of this.renderMetrics.getAll()) {
			lines.push(JSON.stringify({ type: 'render', ...metric }));
		}
		for (const metric of this.chatMetrics.getAll()) {
			lines.push(JSON.stringify({ type: 'chat', ...metric }));
		}
		for (const metric of this.autocompleteMetrics.getAll()) {
			lines.push(JSON.stringify({ type: 'autocomplete', ...metric }));
		}
		for (const metric of this.indexerMetrics.getAll()) {
			lines.push(JSON.stringify({ type: 'indexer', ...metric }));
		}
		for (const metric of this.routerMetrics.getAll()) {
			lines.push(JSON.stringify({ type: 'router', ...metric }));
		}

		return lines.join('\n');
	}

	/**
	 * Clear all metrics
	 */
	clear(): void {
		this.renderMetrics.clear();
		this.chatMetrics.clear();
		this.autocompleteMetrics.clear();
		this.indexerMetrics.clear();
		this.routerMetrics.clear();
		this.chatRequests.clear();
	}
}

// Singleton instance (will be initialized with settings)
let performanceHarnessInstance: PerformanceHarness | undefined;

/**
 * Get or create performance harness instance
 */
export function getPerformanceHarness(enabled: boolean = false): PerformanceHarness {
	if (!performanceHarnessInstance) {
		performanceHarnessInstance = new PerformanceHarness(enabled);
	} else if (enabled !== performanceHarnessInstance.isEnabled()) {
		// Recreate if enabled state changed
		performanceHarnessInstance = new PerformanceHarness(enabled);
	}
	return performanceHarnessInstance;
}

