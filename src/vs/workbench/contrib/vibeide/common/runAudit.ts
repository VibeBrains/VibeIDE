/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Run Comprehensive Performance Audit
 *
 * This script runs all audits and generates a comprehensive report
 * Run in browser console: vibeideRunAudit()
 */

import { vibeLog } from './vibeLog.js';
import { printComprehensiveAuditReport, generateComprehensiveAuditReport } from './comprehensiveAudit.js';
import { startupAudit } from './startupAudit.js';
import { metricsCollector } from './metricsCollector.js';

/**
 * Run full audit and print report
 */
export function runAudit(): void {
	vibeLog.info('runAudit', '🔍 Running Comprehensive Performance Audit...\n');

	// Complete startup audit if not already done
	const startupMetrics = startupAudit.getMetrics();
	if (!startupMetrics) {
		startupAudit.complete();
	}

	// Print comprehensive report
	printComprehensiveAuditReport();

	// Additional diagnostics
	console.group('📊 Additional Diagnostics');
	vibeLog.info('runAudit', `Chat Requests Collected: ${metricsCollector.getAll().length}`);
	vibeLog.info('runAudit', `Startup Metrics Available: ${startupMetrics ? '✅' : '❌'}`);
	console.groupEnd();

	vibeLog.info('runAudit', '\n✅ Audit complete!');
}

/**
 * Get audit report as JSON
 */
export function getAuditReport(): ReturnType<typeof generateComprehensiveAuditReport> {
	return generateComprehensiveAuditReport();
}

// Expose globally
if (typeof window !== 'undefined') {
	(window as any).vibeideRunAudit = runAudit;
	(window as any).vibeideGetAuditReport = getAuditReport;
}

