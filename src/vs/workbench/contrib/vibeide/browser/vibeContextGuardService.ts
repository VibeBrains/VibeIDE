/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';

export type ContextLimitAction = 'compact' | 'continue' | 'cancel';

export interface ContextLimitStatus {
	currentTokens: number;
	maxTokens: number;
	percentUsed: number;
	isWarning: boolean;   // >75% used
	isCritical: boolean;  // >90% used
}

export interface ContextLimitEvent {
	status: ContextLimitStatus;
	message: string;
}

export const IVibeContextGuardService = createDecorator<IVibeContextGuardService>('vibeContextGuardService');

export interface IVibeContextGuardService {
	readonly _serviceBrand: undefined;

	/** Update current context token usage */
	updateUsage(currentTokens: number, maxTokens: number): void;

	/** Get current status */
	getStatus(): ContextLimitStatus;

	/** Event fired when context approaches limit (75% or 90%) */
	readonly onContextLimitWarning: Event<ContextLimitEvent>;

	/** Event fired when critical threshold (90%) is reached mid-task */
	readonly onContextLimitCritical: Event<ContextLimitEvent>;
}

/**
 * VibeIDE Context Guard: live monitoring of context window usage.
 * Warns at 75%, fires critical event at 90% (during active agent task).
 * Critical event triggers: compact / continue with risk / cancel + snapshot dialog.
 */
class VibeContextGuardService extends Disposable implements IVibeContextGuardService {
	declare readonly _serviceBrand: undefined;

	private readonly _onContextLimitWarning = this._register(new Emitter<ContextLimitEvent>());
	readonly onContextLimitWarning = this._onContextLimitWarning.event;

	private readonly _onContextLimitCritical = this._register(new Emitter<ContextLimitEvent>());
	readonly onContextLimitCritical = this._onContextLimitCritical.event;

	private _currentTokens = 0;
	private _maxTokens = 0;
	private _warningFired = false;
	private _criticalFired = false;
	private _warningThreshold: number;
	private _criticalThreshold: number;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._warningThreshold = this._configurationService.getValue<number>('vibeide.context.warningThresholdPercent') ?? 75;
		this._criticalThreshold = this._configurationService.getValue<number>('vibeide.context.criticalThresholdPercent') ?? 90;

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.context')) {
				this._warningThreshold = this._configurationService.getValue<number>('vibeide.context.warningThresholdPercent') ?? 75;
				this._criticalThreshold = this._configurationService.getValue<number>('vibeide.context.criticalThresholdPercent') ?? 90;
			}
		}));
	}

	updateUsage(currentTokens: number, maxTokens: number): void {
		this._currentTokens = currentTokens;
		this._maxTokens = maxTokens;

		const status = this.getStatus();
		this._logService.debug(`[VibeIDE ContextGuard] ${status.percentUsed.toFixed(1)}% (${currentTokens.toLocaleString()}/${maxTokens.toLocaleString()} tokens)`);

		if (status.isCritical && !this._criticalFired) {
			this._criticalFired = true;
			this._warningFired = true;
			const message = localize(
				'vibeContextCritical',
				'Context window is {0}% full ({1} tokens). Choose: compact context, continue with risk, or cancel and save progress.',
				status.percentUsed.toFixed(0),
				currentTokens.toLocaleString()
			);
			this._logService.warn(`[VibeIDE ContextGuard] 🔴 Critical: ${message}`);
			this._onContextLimitCritical.fire({ status, message });
		} else if (status.isWarning && !this._warningFired) {
			this._warningFired = true;
			const message = localize(
				'vibeContextWarning',
				'Context window is {0}% full ({1}/{2} tokens). Consider compacting context.',
				status.percentUsed.toFixed(0),
				currentTokens.toLocaleString(),
				maxTokens.toLocaleString()
			);
			this._logService.warn(`[VibeIDE ContextGuard] ⚠️ Warning: ${message}`);
			this._onContextLimitWarning.fire({ status, message });
		}

		// Reset flags when usage drops (new conversation)
		if (status.percentUsed < 50) {
			this._warningFired = false;
			this._criticalFired = false;
		}
	}

	getStatus(): ContextLimitStatus {
		const percentUsed = this._maxTokens > 0
			? (this._currentTokens / this._maxTokens) * 100
			: 0;
		return {
			currentTokens: this._currentTokens,
			maxTokens: this._maxTokens,
			percentUsed,
			isWarning: percentUsed >= this._warningThreshold,
			isCritical: percentUsed >= this._criticalThreshold,
		};
	}
}

registerSingleton(IVibeContextGuardService, VibeContextGuardService, InstantiationType.Eager);
