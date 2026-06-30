/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Comprehensive Performance Audit Report
 *
 * Combines all audit metrics into a single report
 */

import { vibeLog } from './vibeLog.js';
import { metricsCollector } from './metricsCollector.js';
import type { ChatLatencyMetrics } from './chatLatencyTypes.js';
import { StartupMetrics, startupAudit } from './startupAudit.js';
import { DiffComposerMetrics } from './diffComposerAudit.js';
import { RecoveryMetrics, recoveryAudit } from './recoveryAudit.js';
import { OnboardingMetrics, onboardingAudit } from './onboardingAudit.js';

export interface ComprehensiveAuditReport {
	timestamp: string;

	// Startup metrics
	startup: StartupMetrics | null;

	// Chat metrics (aggregate)
	chat: {
		count: number;
		ttfs: { p50: number; p95: number; mean: number };
		tts: { p50: number; p95: number; mean: number };
		routerDecisionTime: { p50: number; p95: number; mean: number };
		networkLatency: { p50: number; p95: number; mean: number };
		promptAssemblyTime: { p50: number; p95: number; mean: number };
		tokensPerSecond: { p50: number; p95: number; mean: number };
		renderFPS: { p50: number; p95: number; mean: number };
		droppedFrames: { p50: number; p95: number; mean: number };
	};

	// Diff/Composer metrics (latest)
	diffComposer: DiffComposerMetrics | null;

	// Recovery metrics
	recovery: RecoveryMetrics;

	// Onboarding metrics
	onboarding: OnboardingMetrics;

	// Targets met
	targets: {
		ttfs: { target: number; p95: number; met: boolean };
		tts: { target: number; p95: number; met: boolean };
		routerDecision: { target: number; p95: number; met: boolean };
		startup: { target: number; warm: number; met: boolean };
		diffOpen: { target: number; actual: number; met: boolean };
		diffApply: { target: number; actual: number; met: boolean };
		onboarding: { target: number; actual: number; met: boolean };
	};

	// Top bottlenecks
	bottlenecks: string[];
}

/**
 * Calculate tokens per second from metrics
 */
function calculateTokensPerSecond(metrics: ChatLatencyMetrics): number {
	if (metrics.tts <= 0 || metrics.outputTokens <= 0) { return 0; }
	const durationSeconds = metrics.tts / 1000;
	return metrics.outputTokens / durationSeconds;
}

/**
 * Calculate percentiles
 */
function calculatePercentiles(values: number[]): { p50: number; p95: number; mean: number } {
	if (values.length === 0) { return { p50: 0, p95: 0, mean: 0 }; }
	const sorted = [...values].sort((a, b) => a - b);
	const p50 = sorted[Math.floor(sorted.length * 0.5)];
	const p95 = sorted[Math.floor(sorted.length * 0.95)];
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return { p50, p95, mean };
}

/**
 * Generate comprehensive audit report
 */
export function generateComprehensiveAuditReport(): ComprehensiveAuditReport {
	const chatMetrics = metricsCollector.getAll();

	// Calculate chat aggregates
	const ttfsValues = chatMetrics.map(m => m.ttfs).filter(v => v > 0);
	const ttsValues = chatMetrics.map(m => m.tts).filter(v => v > 0);
	const routerValues = chatMetrics.map(m => m.routerDecisionTime).filter(v => v > 0);
	const networkValues = chatMetrics.map(m => m.networkLatency).filter(v => v > 0);
	const promptAssemblyValues = chatMetrics.map(m => m.promptAssemblyTime).filter(v => v > 0);
	const tokensPerSecondValues = chatMetrics.map(calculateTokensPerSecond).filter(v => v > 0);
	const renderFPSValues = chatMetrics.map(m => m.renderFPS).filter(v => v > 0);
	const droppedFramesValues = chatMetrics.map(m => m.droppedFrames).filter(v => v >= 0);

	const chat = {
		count: chatMetrics.length,
		ttfs: calculatePercentiles(ttfsValues),
		tts: calculatePercentiles(ttsValues),
		routerDecisionTime: calculatePercentiles(routerValues),
		networkLatency: calculatePercentiles(networkValues),
		promptAssemblyTime: calculatePercentiles(promptAssemblyValues),
		tokensPerSecond: calculatePercentiles(tokensPerSecondValues),
		renderFPS: calculatePercentiles(renderFPSValues),
		droppedFrames: calculatePercentiles(droppedFramesValues),
	};

	// Get startup metrics
	const startup = startupAudit.getMetrics();

	// Get latest diff/composer metrics (we'd need to track this differently in real implementation)
	// Would be populated from actual session tracking
	const diffComposer: DiffComposerMetrics | null = null as DiffComposerMetrics | null;

	// Get recovery metrics
	const recovery = recoveryAudit.getMetrics();

	// Get onboarding metrics
	const onboarding = onboardingAudit.getMetrics();

	// Check targets - extract values with proper type handling
	let diffOpenTime = 0;
	let diffApplyTime = 0;
	if (diffComposer !== null) {
		diffOpenTime = diffComposer.panelOpenTime;
		diffApplyTime = diffComposer.applyTime;
	}
	const targets = {
		ttfs: { target: 400, p95: chat.ttfs.p95, met: chat.ttfs.p95 <= 400 },
		tts: { target: 3000, p95: chat.tts.p95, met: chat.tts.p95 <= 3000 },
		routerDecision: { target: 10, p95: chat.routerDecisionTime.p95, met: chat.routerDecisionTime.p95 <= 10 },
		startup: { target: 1200, warm: startup?.warmStartTime || 0, met: (startup?.warmStartTime || 0) <= 1200 },
		diffOpen: { target: 250, actual: diffOpenTime, met: diffOpenTime <= 250 },
		diffApply: { target: 300, actual: diffApplyTime, met: diffApplyTime <= 300 },
		onboarding: { target: 90000, actual: onboarding.firstRunDuration, met: onboarding.firstRunDuration <= 90000 },
	};

	// Identify bottlenecks
	const bottlenecks: string[] = [];
	if (chat.ttfs.p95 > 400) {
		bottlenecks.push(`TTFS too high: ${chat.ttfs.p95.toFixed(1)}ms (target: ≤400ms)`);
	}
	if (chat.tts.p95 > 3000) {
		bottlenecks.push(`TTS too high: ${chat.tts.p95.toFixed(1)}ms (target: ≤3000ms)`);
	}
	if (chat.routerDecisionTime.p95 > 10) {
		bottlenecks.push(`Router decision slow: ${chat.routerDecisionTime.p95.toFixed(1)}ms (target: ≤10ms)`);
	}
	if (chat.promptAssemblyTime.p95 > 500) {
		bottlenecks.push(`Prompt assembly slow: ${chat.promptAssemblyTime.p95.toFixed(1)}ms`);
	}
	if (chat.networkLatency.p95 > 200) {
		bottlenecks.push(`Network latency high: ${chat.networkLatency.p95.toFixed(1)}ms`);
	}
	if (startup && startup.warmStartTime > 1200) {
		bottlenecks.push(`Startup slow: ${startup.warmStartTime.toFixed(1)}ms (target: ≤1200ms)`);
	}
	if (diffComposer !== null) {
		const panelTime = diffComposer.panelOpenTime;
		const applyTime = diffComposer.applyTime;
		if (panelTime > 250) {
			bottlenecks.push(`Diff panel open slow: ${panelTime.toFixed(1)}ms (target: ≤250ms)`);
		}
		if (applyTime > 300) {
			bottlenecks.push(`Diff apply slow: ${applyTime.toFixed(1)}ms (target: ≤300ms)`);
		}
	}
	if (onboarding.firstRunDuration > 90000) {
		bottlenecks.push(`Onboarding slow: ${onboarding.firstRunDuration.toFixed(0)}ms (target: ≤90s)`);
	}
	if (chat.renderFPS.p50 < 30) {
		bottlenecks.push(`Render FPS low: ${chat.renderFPS.p50.toFixed(1)} (target: ≥30)`);
	}
	if (chat.droppedFrames.p95 > 10) {
		bottlenecks.push(`Dropped frames high: ${chat.droppedFrames.p95.toFixed(0)} (target: ≤10)`);
	}

	if (bottlenecks.length === 0) {
		bottlenecks.push('No major bottlenecks detected');
	}

	return {
		timestamp: new Date().toISOString(),
		startup,
		chat,
		diffComposer,
		recovery,
		onboarding,
		targets,
		bottlenecks,
	};
}

/**
 * Read an optional numeric field from a target shape without widening to `any`.
 * Returns `undefined` when the field is absent or not a number, so callers can
 * fall through with `??`.
 */
function readTargetNumber(target: object, field: string): number | undefined {
	if (!Object.hasOwn(target, field)) {
		return undefined;
	}
	const candidate = (target as Readonly<Record<string, unknown>>)[field];
	return typeof candidate === 'number' ? candidate : undefined;
}

/**
 * Print comprehensive audit report
 */
export function printComprehensiveAuditReport(): void {
	const report = generateComprehensiveAuditReport();

	console.group('📊 Comprehensive Performance Audit Report');
	vibeLog.info('comprehensiveAudit', `Timestamp: ${report.timestamp}`);
	vibeLog.info('comprehensiveAudit', '');

	// Startup
	if (report.startup) {
		console.group('🚀 Startup');
		vibeLog.info('comprehensiveAudit', `Cold Start: ${report.startup.coldStartTime.toFixed(1)}ms`);
		vibeLog.info('comprehensiveAudit', `Warm Start: ${report.startup.warmStartTime.toFixed(1)}ms (target: ≤1200ms) ${report.targets.startup.met ? '✅' : '❌'}`);
		vibeLog.info('comprehensiveAudit', `Ready to Type: ${report.startup.readyToType.toFixed(1)}ms`);
		vibeLog.info('comprehensiveAudit', `Extension Activation: ${report.startup.extensionActivationTime.toFixed(1)}ms`);
		vibeLog.info('comprehensiveAudit', `Extensions: ${report.startup.extensionCount}`);
		if (report.startup.slowExtensions.length > 0) {
			vibeLog.info('comprehensiveAudit', `Slow Extensions (>100ms):`);
			report.startup.slowExtensions.forEach(ext => {
				vibeLog.info('comprehensiveAudit', `  - ${ext.id}: ${ext.time.toFixed(1)}ms`);
			});
		}
		vibeLog.info('comprehensiveAudit', `Initial Memory: ${report.startup.initialMemoryMB.toFixed(1)}MB`);
		vibeLog.info('comprehensiveAudit', `Peak Memory: ${report.startup.peakMemoryMB.toFixed(1)}MB`);
		console.groupEnd();
	}

	// Chat
	console.group('💬 Chat Performance');
	vibeLog.info('comprehensiveAudit', `Sample Size: ${report.chat.count} requests`);
	vibeLog.info('comprehensiveAudit', `TTFS: ${report.chat.ttfs.p50.toFixed(1)}ms / ${report.chat.ttfs.p95.toFixed(1)}ms (target: ≤400ms) ${report.targets.ttfs.met ? '✅' : '❌'}`);
	vibeLog.info('comprehensiveAudit', `TTS: ${report.chat.tts.p50.toFixed(1)}ms / ${report.chat.tts.p95.toFixed(1)}ms (target: ≤3000ms) ${report.targets.tts.met ? '✅' : '❌'}`);
	if (report.chat.routerDecisionTime.p50 > 0) {
		vibeLog.info('comprehensiveAudit', `Router Decision: ${report.chat.routerDecisionTime.p50.toFixed(1)}ms / ${report.chat.routerDecisionTime.p95.toFixed(1)}ms (target: ≤10ms) ${report.targets.routerDecision.met ? '✅' : '❌'}`);
	}
	vibeLog.info('comprehensiveAudit', `Network Latency: ${report.chat.networkLatency.p50.toFixed(1)}ms / ${report.chat.networkLatency.p95.toFixed(1)}ms`);
	vibeLog.info('comprehensiveAudit', `Prompt Assembly: ${report.chat.promptAssemblyTime.p50.toFixed(1)}ms / ${report.chat.promptAssemblyTime.p95.toFixed(1)}ms`);
	vibeLog.info('comprehensiveAudit', `Tokens/Second: ${report.chat.tokensPerSecond.p50.toFixed(1)} / ${report.chat.tokensPerSecond.p95.toFixed(1)}`);
	vibeLog.info('comprehensiveAudit', `Render FPS: ${report.chat.renderFPS.p50.toFixed(1)} / ${report.chat.renderFPS.p95.toFixed(1)}`);
	vibeLog.info('comprehensiveAudit', `Dropped Frames: (avg): ${report.chat.droppedFrames.mean.toFixed(1)}`);
	console.groupEnd();

	// Diff/Composer
	if (report.diffComposer) {
		console.group('📝 Diff/Composer');
		vibeLog.info('comprehensiveAudit', `Panel Open: ${report.diffComposer.panelOpenTime.toFixed(1)}ms (target: ≤250ms) ${report.targets.diffOpen.met ? '✅' : '❌'}`);
		vibeLog.info('comprehensiveAudit', `Hunk Render: ${report.diffComposer.hunkRenderTime.toFixed(1)}ms (${report.diffComposer.hunkCount} hunks)`);
		vibeLog.info('comprehensiveAudit', `Apply: ${report.diffComposer.applyTime.toFixed(1)}ms (target: ≤300ms) ${report.targets.diffApply.met ? '✅' : '❌'}`);
		vibeLog.info('comprehensiveAudit', `Undo: ${report.diffComposer.undoTime.toFixed(1)}ms`);
		console.groupEnd();
	}

	// Recovery
	console.group('🔄 Recovery');
	vibeLog.info('comprehensiveAudit', `Auto-Stash: ${report.recovery.autoStashCount} operations, avg ${report.recovery.autoStashTime.toFixed(1)}ms`);
	vibeLog.info('comprehensiveAudit', `Rollback: ${report.recovery.rollbackCount} operations, avg ${report.recovery.rollbackTime.toFixed(1)}ms, success: ${report.recovery.rollbackSuccess ? '✅' : '❌'}`);
	vibeLog.info('comprehensiveAudit', `Lost State: ${report.recovery.lostStateIncidents} incidents`);
	vibeLog.info('comprehensiveAudit', `Recovered State: ${report.recovery.recoveredStateIncidents} incidents`);
	console.groupEnd();

	// Onboarding
	console.group('🎓 Onboarding');
	vibeLog.info('comprehensiveAudit', `First-Run Duration: ${(report.onboarding.firstRunDuration / 1000).toFixed(1)}s (target: ≤90s) ${report.targets.onboarding.met ? '✅' : '❌'}`);
	vibeLog.info('comprehensiveAudit', `Time to First Chat: ${(report.onboarding.timeToFirstChat / 1000).toFixed(1)}s`);
	vibeLog.info('comprehensiveAudit', `Time to First Diff Apply: ${(report.onboarding.timeToFirstDiffApply / 1000).toFixed(1)}s`);
	vibeLog.info('comprehensiveAudit', `Command Palette Opened: ${report.onboarding.commandPaletteOpened ? '✅' : '❌'}`);
	vibeLog.info('comprehensiveAudit', `Quick Actions Discovered: ${report.onboarding.quickActionsDiscovered ? '✅' : '❌'}`);
	console.groupEnd();

	// Targets
	console.group('🎯 Targets');
	Object.entries(report.targets).forEach(([key, target]) => {
		const met = target.met;
		// Every target shape carries `met` and `target`; the measured value lives
		// under `p95` (latency families) or `actual` (diff/onboarding). Startup's
		// `warm` field is intentionally not surfaced here — falls through to 0.
		const value = readTargetNumber(target, 'p95') ?? readTargetNumber(target, 'actual') ?? 0;
		const targetValue = target.target;
		vibeLog.info('comprehensiveAudit', `${key}: ${value.toFixed(1)} (target: ${targetValue}) ${met ? '✅' : '❌'}`);
	});
	console.groupEnd();

	// Bottlenecks
	console.group('🔍 Top Bottlenecks');
	report.bottlenecks.forEach((b, i) => {
		vibeLog.info('comprehensiveAudit', `${i + 1}. ${b}`);
	});
	console.groupEnd();

	console.groupEnd();
}

/** Window augmented with the comprehensive-audit entry points exposed for the dev console. */
interface ComprehensiveAuditWindow {
	vibeideComprehensiveAudit: {
		generate: typeof generateComprehensiveAuditReport;
		print: typeof printComprehensiveAuditReport;
	};
}

// Expose globally
if (typeof window !== 'undefined') {
	const auditWindow = window as Window & Partial<ComprehensiveAuditWindow>;
	auditWindow.vibeideComprehensiveAudit = {
		generate: generateComprehensiveAuditReport,
		print: printComprehensiveAuditReport,
	};
}

