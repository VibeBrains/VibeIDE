/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * Centralized offline/privacy mode gate
 * Ensures no remote requests are made when offline or in privacy mode
 */
export class OfflinePrivacyGate {
	constructor() {}

	/**
	 * Check if we're in offline or privacy mode
	 */
	isOfflineOrPrivacyMode(): boolean {
		// Check navigator.onLine (browser environment)
		if (typeof navigator !== 'undefined' && !navigator.onLine) {
			return true;
		}

		// Note: Privacy mode enforcement is handled at the model router level via requiresPrivacy
		// This gate primarily handles offline detection
		return false;
	}

	/**
	 * Throw an error if offline/privacy mode is active
	 * @param operationName Human-readable name of the operation being blocked
	 * @param allowOverride If true, error message includes override option
	 */
	ensureNotOfflineOrPrivacy(operationName: string, allowOverride: boolean = false): void {
		if (this.isOfflineOrPrivacyMode()) {
			const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

			let message: string;
			if (isOffline) {
				message = localize('offlineBlocked', '{0} is unavailable: you are currently offline. Please check your internet connection.', operationName);
			} else {
				message = localize('privacyBlocked', '{0} is unavailable: privacy mode is enabled. Please disable privacy mode to use this feature.', operationName);
			}

			if (allowOverride) {
				message += ' ' + localize('overrideHint', 'You can override this in settings.');
			}

			throw new Error(message);
		}
	}

	/**
	 * Get a user-friendly message explaining why an operation was blocked
	 */
	getBlockedMessage(operationName: string): string {
		const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

		if (isOffline) {
			return localize('offlineBlocked', '{0} is unavailable: you are currently offline. Please check your internet connection.', operationName);
		}

		return localize('unknownBlocked', '{0} is unavailable.', operationName);
	}
}

