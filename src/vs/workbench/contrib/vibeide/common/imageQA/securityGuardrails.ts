/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Security and Privacy Guardrails for Image QA Pipeline
 * Provides checks before remote model calls and audit logging
 */

import type { ILogService } from '../../../../../platform/log/common/log.js';

export interface SecurityCheckResult {
	allowed: boolean;
	reason?: string;
	requiresConsent?: boolean;
}

/**
 * Check if remote model call is allowed
 */
export function checkRemoteModelCall(
	allowRemoteModels: boolean,
	imageSize: number,
	logService?: ILogService
): SecurityCheckResult {
	// Log the decision
	if (logService) {
		logService.debug('[ImageQA Security] Remote model call check', {
			allowRemoteModels,
			imageSize,
		});
	}

	if (!allowRemoteModels) {
		if (logService) {
			logService.info('[ImageQA Security] Remote model call blocked - remote models disabled');
		}
		return {
			allowed: false,
			reason: 'Remote models are disabled in settings',
		};
	}

	// Check image size (prevent sending extremely large images)
	const MAX_REMOTE_IMAGE_SIZE = 50 * 1024 * 1024; // 50 MB
	if (imageSize > MAX_REMOTE_IMAGE_SIZE) {
		if (logService) {
			logService.warn('[ImageQA Security] Remote model call blocked - image too large', {
				imageSize,
				maxSize: MAX_REMOTE_IMAGE_SIZE,
			});
		}
		return {
			allowed: false,
			reason: `Image size (${(imageSize / 1024 / 1024).toFixed(2)} MB) exceeds maximum for remote processing (50 MB)`,
		};
	}

	if (logService) {
		logService.info('[ImageQA Security] Remote model call allowed');
	}

	return {
		allowed: true,
	};
}

/**
 * Log image processing decision for audit trail
 */
export function logImageProcessingDecision(
	routingPath: string,
	imageType: string,
	questionType: string,
	usesRemote: boolean,
	modelInfo?: { provider: string; model: string },
	logService?: ILogService
): void {
	if (logService) {
		logService.info('[ImageQA Audit] Processing decision', {
			routingPath,
			imageType,
			questionType,
			usesRemote,
			model: modelInfo ? `${modelInfo.provider}:${modelInfo.model}` : 'none',
			timestamp: new Date().toISOString(),
		});
	}
}

