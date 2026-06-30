/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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

/** Window augmented with the audit entry points exposed for the dev console. */
interface AuditWindow {
	vibeideRunAudit: typeof runAudit;
	vibeideGetAuditReport: typeof getAuditReport;
}

// Expose globally
if (typeof window !== 'undefined') {
	const auditWindow = window as Window & Partial<AuditWindow>;
	auditWindow.vibeideRunAudit = runAudit;
	auditWindow.vibeideGetAuditReport = getAuditReport;
}

