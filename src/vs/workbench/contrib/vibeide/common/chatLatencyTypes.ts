/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared types for chat latency auditing
 * This file exists to break cyclic dependencies between chatLatencyAudit.ts and performanceAudit.ts
 */

export interface ChatLatencyMetrics {
	// Timing metrics
	ttfs: number; // Time to first token (ms)
	tts: number; // Time to stable/complete (ms)
	routerDecisionTime: number; // Time for router to select model (ms)
	networkLatency: number; // DNS + TLS + HTTP overhead (ms)
	promptAssemblyTime: number; // Time to assemble prompt (ms)
	tokenizationTime: number; // Time to tokenize prompt (ms)
	firstChunkProcessTime: number; // Time to process first chunk (ms)

	// Token metrics
	promptTokens: number;
	attachmentTokens: number;
	totalInputTokens: number;
	outputTokens: number;

	// Network metrics
	dnsTime?: number;
	tlsTime?: number;
	httpTime?: number;

	// Render metrics
	renderFPS: number; // Average FPS during streaming
	droppedFrames: number;
	framesDropped: number; // Total frames dropped (alias for droppedFrames)
	avgBatchSize: number; // Average batch size for token updates

	// Context metrics
	contextSize: number; // Characters in context
	contextTruncated: boolean;

	// Provider info
	providerName: string;
	modelName: string;

	// Request info
	requestId: string;
	timestamp: number;
}

