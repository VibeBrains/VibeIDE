/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Onboarding Performance Audit
 *
 * Tracks time to first useful action, discoverability metrics
 */

export interface OnboardingMetrics {
	// First-run flow
	firstRunStartTime: number;
	firstRunCompleteTime: number;
	firstRunDuration: number; // Total time to complete onboarding (ms)
	firstRunCompleted: boolean;

	// Time to first action
	timeToFirstChat: number; // Time to first chat message (ms)
	timeToFirstQuickAction: number; // Time to first quick action (ms)
	timeToFirstComposer: number; // Time to first composer use (ms)
	timeToFirstDiffApply: number; // Time to first diff apply (ms)

	// Discoverability
	commandPaletteOpened: boolean;
	commandPaletteTime: number; // Time to open command palette (ms)
	quickActionsDiscovered: boolean;
	composerDiscovered: boolean;

	timestamp: number;
}

class OnboardingAudit {
	private metrics: OnboardingMetrics = {
		firstRunStartTime: 0,
		firstRunCompleteTime: 0,
		firstRunDuration: 0,
		firstRunCompleted: false,
		timeToFirstChat: 0,
		timeToFirstQuickAction: 0,
		timeToFirstComposer: 0,
		timeToFirstDiffApply: 0,
		commandPaletteOpened: false,
		commandPaletteTime: 0,
		quickActionsDiscovered: false,
		composerDiscovered: false,
		timestamp: Date.now(),
	};

	private appStartTime: number = performance.now();
	private firstRunStartTime: number = 0;

	/**
	 * Mark first-run flow start
	 */
	markFirstRunStart(): void {
		this.firstRunStartTime = performance.now();
		this.metrics.firstRunStartTime = this.firstRunStartTime;
	}

	/**
	 * Mark first-run flow complete
	 */
	markFirstRunComplete(): void {
		const now = performance.now();
		this.metrics.firstRunCompleteTime = now;
		this.metrics.firstRunDuration = now - this.firstRunStartTime;
		this.metrics.firstRunCompleted = true;
	}

	/**
	 * Mark first chat message
	 */
	markFirstChat(): void {
		if (this.metrics.timeToFirstChat === 0) {
			this.metrics.timeToFirstChat = performance.now() - this.appStartTime;
		}
	}

	/**
	 * Mark first quick action
	 */
	markFirstQuickAction(): void {
		if (this.metrics.timeToFirstQuickAction === 0) {
			this.metrics.timeToFirstQuickAction = performance.now() - this.appStartTime;
			this.metrics.quickActionsDiscovered = true;
		}
	}

	/**
	 * Mark first composer use
	 */
	markFirstComposer(): void {
		if (this.metrics.timeToFirstComposer === 0) {
			this.metrics.timeToFirstComposer = performance.now() - this.appStartTime;
			this.metrics.composerDiscovered = true;
		}
	}

	/**
	 * Mark first diff apply
	 */
	markFirstDiffApply(): void {
		if (this.metrics.timeToFirstDiffApply === 0) {
			this.metrics.timeToFirstDiffApply = performance.now() - this.appStartTime;
		}
	}

	/**
	 * Mark command palette opened
	 */
	markCommandPaletteOpened(): void {
		if (!this.metrics.commandPaletteOpened) {
			this.metrics.commandPaletteOpened = true;
			this.metrics.commandPaletteTime = performance.now() - this.appStartTime;
		}
	}

	/**
	 * Get current metrics
	 */
	getMetrics(): OnboardingMetrics {
		return { ...this.metrics, timestamp: Date.now() };
	}

	/**
	 * Reset metrics
	 */
	reset(): void {
		this.appStartTime = performance.now();
		this.firstRunStartTime = 0;
		this.metrics = {
			firstRunStartTime: 0,
			firstRunCompleteTime: 0,
			firstRunDuration: 0,
			firstRunCompleted: false,
			timeToFirstChat: 0,
			timeToFirstQuickAction: 0,
			timeToFirstComposer: 0,
			timeToFirstDiffApply: 0,
			commandPaletteOpened: false,
			commandPaletteTime: 0,
			quickActionsDiscovered: false,
			composerDiscovered: false,
			timestamp: Date.now(),
		};
	}
}

// Singleton instance
export const onboardingAudit = new OnboardingAudit();

