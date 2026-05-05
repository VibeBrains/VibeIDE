/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Performance Audit Script
 *
 * Collects and reports baseline performance metrics for Auto mode and single-model usage.
 * Run this in the browser console or via a command to get performance reports.
 */

import { metricsCollector } from './metricsCollector.js';
import { ChatLatencyMetrics } from './chatLatencyTypes.js';

export interface PerformanceAuditReport {
	timestamp: string;
	mode: 'auto' | 'single';
	metrics: {
		ttfs: { p50: number; p95: number; mean: number };
		tts: { p50: number; p95: number; mean: number };
		routerDecisionTime: { p50: number; p95: number; mean: number };
		networkLatency: { p50: number; p95: number; mean: number };
		promptAssemblyTime: { p50: number; p95: number; mean: number };
		tokensPerSecond: { p50: number; p95: number; mean: number };
		totalInputTokens: { p50: number; mean: number };
		outputTokens: { p50: number; mean: number };
	};
	targets: {
		ttfs: { target: number; met: boolean };
		tts: { target: number; met: boolean };
		routerDecisionTime: { target: number; met: boolean };
		tokensPerSecond: { target: number; met: boolean };
	};
	bottlenecks: string[];
}

/**
 * Calculate tokens per second from metrics
 */
function calculateTokensPerSecond(metrics: ChatLatencyMetrics): number {
	if (metrics.tts <= 0 || metrics.outputTokens <= 0) return 0;
	const durationSeconds = metrics.tts / 1000;
	return metrics.outputTokens / durationSeconds;
}

/**
 * Calculate percentiles from array of numbers
 */
function calculatePercentiles(values: number[]): { p50: number; p95: number; mean: number } {
	if (values.length === 0) return { p50: 0, p95: 0, mean: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const p50 = sorted[Math.floor(sorted.length * 0.5)];
	const p95 = sorted[Math.floor(sorted.length * 0.95)];
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return { p50, p95, mean };
}

/**
 * Generate performance audit report from collected metrics
 */
export function generatePerformanceAuditReport(mode: 'auto' | 'single' = 'auto'): PerformanceAuditReport {
	const allMetrics = metricsCollector.getAll();

	// Filter by mode if needed (for now, we don't distinguish in metrics)
	const relevantMetrics = allMetrics.filter(m => {
		// For auto mode, router time should be > 0
		// For single mode, router time should be 0 or very small
		if (mode === 'auto') {
			return m.routerDecisionTime > 0;
		} else {
			return m.routerDecisionTime <= 1; // Single mode has instant routing
		}
	});

	if (relevantMetrics.length === 0) {
		return {
			timestamp: new Date().toISOString(),
			mode,
			metrics: {
				ttfs: { p50: 0, p95: 0, mean: 0 },
				tts: { p50: 0, p95: 0, mean: 0 },
				routerDecisionTime: { p50: 0, p95: 0, mean: 0 },
				networkLatency: { p50: 0, p95: 0, mean: 0 },
				promptAssemblyTime: { p50: 0, p95: 0, mean: 0 },
				tokensPerSecond: { p50: 0, p95: 0, mean: 0 },
				totalInputTokens: { p50: 0, mean: 0 },
				outputTokens: { p50: 0, mean: 0 },
			},
			targets: {
				ttfs: { target: mode === 'auto' ? 400 : 400, met: false },
				tts: { target: mode === 'auto' ? 3000 : 3000, met: false },
				routerDecisionTime: { target: 10, met: false },
				tokensPerSecond: { target: mode === 'auto' ? 0 : 35, met: false },
			},
			bottlenecks: ['No metrics collected yet'],
		};
	}

	// Extract metrics
	const ttfsValues = relevantMetrics.map(m => m.ttfs).filter(v => v > 0);
	const ttsValues = relevantMetrics.map(m => m.tts).filter(v => v > 0);
	const routerValues = relevantMetrics.map(m => m.routerDecisionTime).filter(v => v > 0);
	const networkValues = relevantMetrics.map(m => m.networkLatency).filter(v => v > 0);
	const promptAssemblyValues = relevantMetrics.map(m => m.promptAssemblyTime).filter(v => v > 0);
	const tokensPerSecondValues = relevantMetrics.map(calculateTokensPerSecond).filter(v => v > 0);
	const inputTokenValues = relevantMetrics.map(m => m.totalInputTokens);
	const outputTokenValues = relevantMetrics.map(m => m.outputTokens);

	const metrics = {
		ttfs: calculatePercentiles(ttfsValues),
		tts: calculatePercentiles(ttsValues),
		routerDecisionTime: calculatePercentiles(routerValues),
		networkLatency: calculatePercentiles(networkValues),
		promptAssemblyTime: calculatePercentiles(promptAssemblyValues),
		tokensPerSecond: calculatePercentiles(tokensPerSecondValues),
		totalInputTokens: calculatePercentiles(inputTokenValues),
		outputTokens: calculatePercentiles(outputTokenValues),
	};

	// Check targets
	const ttfsTarget = mode === 'auto' ? 400 : 400; // Remote fast path
	const ttsTarget = 3000; // 300 tokens in 3s
	const routerTarget = 10; // Router decision ≤ 10ms
	const tokensPerSecondTarget = mode === 'auto' ? 0 : 35; // Local models

	const targets = {
		ttfs: { target: ttfsTarget, met: metrics.ttfs.p95 <= ttfsTarget },
		tts: { target: ttsTarget, met: metrics.tts.p95 <= ttsTarget },
		routerDecisionTime: { target: routerTarget, met: metrics.routerDecisionTime.p95 <= routerTarget },
		tokensPerSecond: { target: tokensPerSecondTarget, met: metrics.tokensPerSecond.p50 >= tokensPerSecondTarget },
	};

	// Identify bottlenecks
	const bottlenecks: string[] = [];
	if (metrics.routerDecisionTime.p95 > 10) {
		bottlenecks.push(`Router decision time too high: ${metrics.routerDecisionTime.p95.toFixed(2)}ms (target: ≤10ms)`);
	}
	if (metrics.ttfs.p95 > ttfsTarget) {
		bottlenecks.push(`TTFS too high: ${metrics.ttfs.p95.toFixed(2)}ms (target: ≤${ttfsTarget}ms)`);
	}
	if (metrics.networkLatency.p95 > 200) {
		bottlenecks.push(`Network latency high: ${metrics.networkLatency.p95.toFixed(2)}ms`);
	}
	if (metrics.promptAssemblyTime.p95 > 500) {
		bottlenecks.push(`Prompt assembly slow: ${metrics.promptAssemblyTime.p95.toFixed(2)}ms`);
	}
	if (mode !== 'auto' && metrics.tokensPerSecond.p50 < tokensPerSecondTarget) {
		bottlenecks.push(`Throughput low: ${metrics.tokensPerSecond.p50.toFixed(1)} tokens/s (target: ≥${tokensPerSecondTarget})`);
	}
	if (bottlenecks.length === 0) {
		bottlenecks.push('No major bottlenecks detected');
	}

	return {
		timestamp: new Date().toISOString(),
		mode,
		metrics,
		targets,
		bottlenecks,
	};
}

/**
 * Print performance audit report to console
 */
export function printPerformanceAuditReport(mode: 'auto' | 'single' = 'auto'): void {
	const report = generatePerformanceAuditReport(mode);

	console.group(`📊 Performance Audit Report - ${mode.toUpperCase()} Mode`);
	console.log(`Timestamp: ${report.timestamp}`);
	console.log(`Sample Size: ${metricsCollector.getAll().length} requests`);
	console.log('');

	console.group('📈 Metrics (p50 / p95 / mean)');
	console.log(`TTFS: ${report.metrics.ttfs.p50.toFixed(1)}ms / ${report.metrics.ttfs.p95.toFixed(1)}ms / ${report.metrics.ttfs.mean.toFixed(1)}ms`);
	console.log(`TTS: ${report.metrics.tts.p50.toFixed(1)}ms / ${report.metrics.tts.p95.toFixed(1)}ms / ${report.metrics.tts.mean.toFixed(1)}ms`);
	if (report.metrics.routerDecisionTime.p50 > 0) {
		console.log(`Router Decision: ${report.metrics.routerDecisionTime.p50.toFixed(1)}ms / ${report.metrics.routerDecisionTime.p95.toFixed(1)}ms / ${report.metrics.routerDecisionTime.mean.toFixed(1)}ms`);
	}
	console.log(`Network Latency: ${report.metrics.networkLatency.p50.toFixed(1)}ms / ${report.metrics.networkLatency.p95.toFixed(1)}ms / ${report.metrics.networkLatency.mean.toFixed(1)}ms`);
	console.log(`Prompt Assembly: ${report.metrics.promptAssemblyTime.p50.toFixed(1)}ms / ${report.metrics.promptAssemblyTime.p95.toFixed(1)}ms / ${report.metrics.promptAssemblyTime.mean.toFixed(1)}ms`);
	if (report.metrics.tokensPerSecond.p50 > 0) {
		console.log(`Tokens/Second: ${report.metrics.tokensPerSecond.p50.toFixed(1)} / ${report.metrics.tokensPerSecond.p95.toFixed(1)} / ${report.metrics.tokensPerSecond.mean.toFixed(1)}`);
	}
	console.log(`Input Tokens: ${report.metrics.totalInputTokens.p50} / ${report.metrics.totalInputTokens.mean.toFixed(0)}`);
	console.log(`Output Tokens: ${report.metrics.outputTokens.p50} / ${report.metrics.outputTokens.mean.toFixed(0)}`);
	console.groupEnd();

	console.group('🎯 Targets');
	console.log(`TTFS ≤${report.targets.ttfs.target}ms: ${report.targets.ttfs.met ? '✅' : '❌'} (${report.metrics.ttfs.p95.toFixed(1)}ms)`);
	console.log(`TTS ≤${report.targets.tts.target}ms: ${report.targets.tts.met ? '✅' : '❌'} (${report.metrics.tts.p95.toFixed(1)}ms)`);
	if (report.metrics.routerDecisionTime.p50 > 0) {
		console.log(`Router ≤${report.targets.routerDecisionTime.target}ms: ${report.targets.routerDecisionTime.met ? '✅' : '❌'} (${report.metrics.routerDecisionTime.p95.toFixed(1)}ms)`);
	}
	if (report.targets.tokensPerSecond.target > 0) {
		console.log(`Tokens/s ≥${report.targets.tokensPerSecond.target}: ${report.targets.tokensPerSecond.met ? '✅' : '❌'} (${report.metrics.tokensPerSecond.p50.toFixed(1)})`);
	}
	console.groupEnd();

	console.group('🔍 Top Bottlenecks');
	report.bottlenecks.forEach((b, i) => {
		console.log(`${i + 1}. ${b}`);
	});
	console.groupEnd();

	console.groupEnd();
}

/**
 * Clear collected metrics (for fresh audit)
 */
export function clearPerformanceMetrics(): void {
	metricsCollector.clear();
	console.log('✅ Performance metrics cleared');
}

/**
 * Export metrics for external analysis
 */
export function exportPerformanceMetrics(): ChatLatencyMetrics[] {
	return metricsCollector.getAll();
}

