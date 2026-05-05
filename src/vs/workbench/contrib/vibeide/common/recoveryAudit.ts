/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { IAuditLogService } from './auditLogService.js';

/**
 * Recovery Performance Audit
 *
 * Tracks auto-stash operations, rollback success, error recovery times
 */

export interface RecoveryMetrics {
	// Auto-stash operations
	autoStashCount: number;
	autoStashTime: number; // Time to create auto-stash (ms)
	autoStashSize: number; // Size of stashed data (bytes)

	// Rollback operations
	rollbackCount: number;
	rollbackTime: number; // Time to rollback (ms)
	rollbackSuccess: boolean;

	// Error recovery
	errorRecoveryTime: number; // Time to recover from error (ms)
	errorType: string;
	recoverySuccess: boolean;

	// Lost state incidents
	lostStateIncidents: number;
	recoveredStateIncidents: number;

	timestamp: number;
}

class RecoveryAudit {
	private metrics: RecoveryMetrics = {
		autoStashCount: 0,
		autoStashTime: 0,
		autoStashSize: 0,
		rollbackCount: 0,
		rollbackTime: 0,
		rollbackSuccess: true,
		errorRecoveryTime: 0,
		errorType: '',
		recoverySuccess: true,
		lostStateIncidents: 0,
		recoveredStateIncidents: 0,
		timestamp: Date.now(),
	};

	private autoStashTimes: number[] = [];
	private rollbackTimes: number[] = [];
	private errorRecoveryTimes: number[] = [];

	/**
	 * Record auto-stash operation
	 */
	recordAutoStash(time: number, size: number): void {
		this.metrics.autoStashCount++;
		this.autoStashTimes.push(time);
		this.metrics.autoStashTime = this.autoStashTimes.reduce((a, b) => a + b, 0) / this.autoStashTimes.length;
		this.metrics.autoStashSize += size;
	}

	/**
	 * Record rollback operation
	 */
	recordRollback(time: number, success: boolean, auditLogService?: IAuditLogService): void {
		this.metrics.rollbackCount++;
		this.rollbackTimes.push(time);
		this.metrics.rollbackTime = this.rollbackTimes.reduce((a, b) => a + b, 0) / this.rollbackTimes.length;
		this.metrics.rollbackSuccess = success;

		// Audit log: record rollback
		if (auditLogService?.isEnabled()) {
			auditLogService.append({
				ts: Date.now(),
				action: 'rollback',
				ok: success,
				meta: {
					rollbackTime: time,
				},
			}).catch(() => {
				// Ignore audit log errors
			});
		}
	}

	/**
	 * Record error recovery
	 */
	recordErrorRecovery(time: number, errorType: string, success: boolean): void {
		this.errorRecoveryTimes.push(time);
		this.metrics.errorRecoveryTime = this.errorRecoveryTimes.reduce((a, b) => a + b, 0) / this.errorRecoveryTimes.length;
		this.metrics.errorType = errorType;
		this.metrics.recoverySuccess = success;
	}

	/**
	 * Record lost state incident
	 */
	recordLostState(): void {
		this.metrics.lostStateIncidents++;
	}

	/**
	 * Record recovered state incident
	 */
	recordRecoveredState(): void {
		this.metrics.recoveredStateIncidents++;
	}

	/**
	 * Get current metrics
	 */
	getMetrics(): RecoveryMetrics {
		return { ...this.metrics, timestamp: Date.now() };
	}

	/**
	 * Reset metrics
	 */
	reset(): void {
		this.metrics = {
			autoStashCount: 0,
			autoStashTime: 0,
			autoStashSize: 0,
			rollbackCount: 0,
			rollbackTime: 0,
			rollbackSuccess: true,
			errorRecoveryTime: 0,
			errorType: '',
			recoverySuccess: true,
			lostStateIncidents: 0,
			recoveredStateIncidents: 0,
			timestamp: Date.now(),
		};
		this.autoStashTimes = [];
		this.rollbackTimes = [];
		this.errorRecoveryTimes = [];
	}
}

// Singleton instance
export const recoveryAudit = new RecoveryAudit();

