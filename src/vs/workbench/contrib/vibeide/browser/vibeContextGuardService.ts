/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';

import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface the context-guard thresholds in VS Code's Settings UI. Without this
// block both keys read below by the constructor exist only via the `??`
// defaults (75% / 90%), so users never see them in the editor and can't tune
// when the warning/critical events fire. Defaults match the in-code fallbacks.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.context.warningThresholdPercent': {
			type: 'number',
			default: 75,
			minimum: 50,
			maximum: 95,
			description: localize('vibeide.context.warningThresholdPercent', 'Процент заполнения контекстного окна, при котором показывается non-blocking warning о приближающемся лимите. По умолчанию 75%. Должен быть ниже `criticalThresholdPercent`.'),
		},
		'vibeide.context.criticalThresholdPercent': {
			type: 'number',
			default: 90,
			minimum: 60,
			maximum: 99,
			description: localize('vibeide.context.criticalThresholdPercent', 'Процент заполнения контекстного окна, при котором mid-task поднимается blocking-диалог "compact / continue / cancel + снапшот". По умолчанию 90%. Должен быть выше `warningThresholdPercent`.'),
		},
		'vibeide.context.tokenCalibrationMaxFactor': {
			type: 'number',
			default: 8,
			minimum: 1,
			maximum: 20,
			description: localize('vibeide.context.tokenCalibrationMaxFactor', 'Верхняя граница калибровочного коэффициента «оценка→реальные токены». Грубая оценка размера промпта (длина/4) у reasoning-моделей и плотных токенизаторов (код/CJK) занижает реальное число токенов; коэффициент это компенсирует, но зажат сверху во избежание выброса от аномального замера. Дефолт 8 (раньше было жёстко 3 — упиралось на моделях вроде deepseek). Поднимите, если индикатор контекста всё ещё занижает; диапазон 1–20.'),
		},
	},
});

export type ContextLimitAction = 'compact' | 'continue' | 'cancel';

export interface ContextLimitStatus {
	currentTokens: number;
	maxTokens: number;
	percentUsed: number;
	isWarning: boolean;   // >75% used
	isCritical: boolean;  // >90% used
	/** Budget-fill truncation transparency: how many most-recent messages were kept at full
	 * fidelity on the last prompt build. `undefined` when no truncation occurred. */
	keptMessages?: number;
	/** Budget-fill truncation transparency: how many older messages were folded into the
	 * <chat_summary>. `undefined` / 0 when no truncation occurred. */
	summarizedMessages?: number;
	/** Learned estimate→real token-calibration factor applied to currentTokens (D.9 diagnostic). */
	calibrationFactor?: number;
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

	/**
	 * Record budget-fill truncation stats for transparency in the UI context indicator.
	 * Pass `(undefined, undefined)` at the start of each prompt build to clear stale stats;
	 * pass the kept/summarized message counts when truncation actually fires. Does not emit
	 * on its own — the stats ride along on the next `updateUsage` fire (which always follows
	 * in the same build), so there is no extra event churn.
	 */
	setTruncationStats(keptMessages: number | undefined, summarizedMessages: number | undefined): void;

	/** Record the learned token-calibration factor for the UI indicator tooltip (D.9). Rides along
	 *  on the next `updateUsage` fire, like `setTruncationStats`. */
	setCalibrationFactor(factor: number | undefined): void;

	/**
	 * Reset usage counters to zero (e.g. when the user switches to a different
	 * chat thread). Status bar refreshes immediately; the next request through
	 * convertToLLMMessageService.updateUsage re-populates with the new thread's
	 * real size.
	 */
	reset(): void;

	/** Get current status */
	getStatus(): ContextLimitStatus;

	/** Event fired on every updateUsage call (for live status bar refresh) */
	readonly onUsageUpdated: Event<ContextLimitStatus>;

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

	private readonly _onUsageUpdated = this._register(new Emitter<ContextLimitStatus>());
	readonly onUsageUpdated = this._onUsageUpdated.event;

	private readonly _onContextLimitWarning = this._register(new Emitter<ContextLimitEvent>());
	readonly onContextLimitWarning = this._onContextLimitWarning.event;

	private readonly _onContextLimitCritical = this._register(new Emitter<ContextLimitEvent>());
	readonly onContextLimitCritical = this._onContextLimitCritical.event;

	private _currentTokens = 0;
	private _maxTokens = 0;
	private _keptMessages: number | undefined = undefined;
	private _summarizedMessages: number | undefined = undefined;
	private _calibrationFactor: number | undefined = undefined;
	private _warningFired = false;
	private _criticalFired = false;
	private _warningThreshold: number;
	private _criticalThreshold: number;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
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
		// NOTE: reset on thread switch is driven from ChatThreadService (it owns
		// the onDidChangeCurrentThread event and calls our reset()). Subscribing
		// here would create a cyclic module graph: chatThreadService imports
		// convertToLLMMessageService which imports vibeContextGuardService —
		// so vibeContextGuardService importing chatThreadService closes the loop
		// and the bundler refuses to compile. Wiring stays downstream-only.
	}

	updateUsage(currentTokens: number, maxTokens: number): void {
		this._currentTokens = currentTokens;
		this._maxTokens = maxTokens;

		const status = this.getStatus();
		this._onUsageUpdated.fire(status);
		vibeLog.debug('ContextGuard', `${status.percentUsed.toFixed(1)}% (${currentTokens.toLocaleString()}/${maxTokens.toLocaleString()} tokens)`);

		if (status.isCritical && !this._criticalFired) {
			this._criticalFired = true;
			this._warningFired = true;
			const message = localize(
				'vibeContextCritical',
				'Context window is {0}% full ({1} tokens). Choose: compact context, continue with risk, or cancel and save progress.',
				status.percentUsed.toFixed(0),
				currentTokens.toLocaleString()
			);
			vibeLog.warn('ContextGuard', `🔴 Critical: ${message}`);
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
			vibeLog.warn('ContextGuard', `⚠️ Warning: ${message}`);
			this._onContextLimitWarning.fire({ status, message });
		}

		// Reset flags when usage drops (new conversation)
		if (status.percentUsed < 50) {
			this._warningFired = false;
			this._criticalFired = false;
		}
	}

	setTruncationStats(keptMessages: number | undefined, summarizedMessages: number | undefined): void {
		this._keptMessages = keptMessages;
		this._summarizedMessages = summarizedMessages;
	}

	setCalibrationFactor(factor: number | undefined): void {
		this._calibrationFactor = factor;
	}

	reset(): void {
		this._currentTokens = 0;
		this._maxTokens = 0;
		this._keptMessages = undefined;
		this._summarizedMessages = undefined;
		this._calibrationFactor = undefined;
		this._warningFired = false;
		this._criticalFired = false;
		this._onUsageUpdated.fire(this.getStatus());
		vibeLog.debug('ContextGuard', 'Reset (thread changed)');
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
			keptMessages: this._keptMessages,
			summarizedMessages: this._summarizedMessages,
			calibrationFactor: this._calibrationFactor,
		};
	}
}

registerSingleton(IVibeContextGuardService, VibeContextGuardService, InstantiationType.Eager);
