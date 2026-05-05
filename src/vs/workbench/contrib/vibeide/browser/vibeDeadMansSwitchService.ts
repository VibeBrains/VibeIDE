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

export const IVibeDeadMansSwitchService = createDecorator<IVibeDeadMansSwitchService>('vibeDeadMansSwitchService');

export interface IVibeDeadMansSwitchService {
	readonly _serviceBrand: undefined;

	/** Start DMS timer for current agent task */
	start(taskId: string): void;

	/**
	 * Reset DMS timer — called on explicit Approve action.
	 * NOTE: Mouse movement, rate limit 429 retries, and pre-flight plan waiting do NOT reset DMS.
	 */
	approve(taskId: string): void;

	/** Stop DMS timer (task completed or cancelled) */
	stop(taskId: string): void;

	/** Exclude a task from DMS (e.g., during pre-flight plan approval) */
	excludeFromTimer(taskId: string): void;

	/** Remove exclusion */
	includeInTimer(taskId: string): void;

	readonly onAgentPaused: Event<{ taskId: string; reason: string }>;
	readonly onAgentResumed: Event<{ taskId: string }>;
}

/**
 * VibeIDE Dead Man's Switch: pauses agent if no explicit Approve action within N minutes.
 *
 * What DOES reset the timer:
 *   - Explicit Approve action from user
 *
 * What does NOT reset the timer:
 *   - Mouse movement
 *   - Rate limit 429 + retry backoff (use excludeFromTimer during retry)
 *   - Pre-flight plan waiting (use excludeFromTimer before showing plan)
 */
class VibeDeadMansSwitchService extends Disposable implements IVibeDeadMansSwitchService {
	declare readonly _serviceBrand: undefined;

	private readonly _onAgentPaused = this._register(new Emitter<{ taskId: string; reason: string }>());
	readonly onAgentPaused = this._onAgentPaused.event;

	private readonly _onAgentResumed = this._register(new Emitter<{ taskId: string }>());
	readonly onAgentResumed = this._onAgentResumed.event;

	private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly _excluded = new Set<string>();
	private _timeoutMs: number;
	private _enabled: boolean;

	// Default: 5 minutes. Minimum: 1 minute (N=0 = disable)
	private static readonly DEFAULT_TIMEOUT_MINUTES = 5;
	private static readonly MIN_TIMEOUT_MINUTES = 1;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		const configMinutes = this._configurationService.getValue<number>('vibeide.safety.deadMansSwitchMinutes')
			?? VibeDeadMansSwitchService.DEFAULT_TIMEOUT_MINUTES;
		this._timeoutMs = this._getValidatedTimeoutMs(configMinutes);
		this._enabled = configMinutes !== 0;

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.safety.deadMansSwitchMinutes')) {
				const minutes = this._configurationService.getValue<number>('vibeide.safety.deadMansSwitchMinutes')
					?? VibeDeadMansSwitchService.DEFAULT_TIMEOUT_MINUTES;
				this._enabled = minutes !== 0;
				this._timeoutMs = this._getValidatedTimeoutMs(minutes);
			}
		}));
	}

	private _getValidatedTimeoutMs(minutes: number): number {
		if (minutes === 0) return 0; // 0 = disable
		const clamped = Math.max(VibeDeadMansSwitchService.MIN_TIMEOUT_MINUTES, minutes);
		return clamped * 60 * 1000;
	}

	start(taskId: string): void {
		if (!this._enabled) return;
		this._clearTimer(taskId);
		this._scheduleTimer(taskId);
		this._logService.debug(`[VibeIDE DMS] Started for task ${taskId} (timeout: ${this._timeoutMs / 60000} min)`);
	}

	approve(taskId: string): void {
		if (!this._enabled) return;
		if (this._excluded.has(taskId)) return;
		this._clearTimer(taskId);
		this._scheduleTimer(taskId);
		this._logService.debug(`[VibeIDE DMS] Approved / timer reset for task ${taskId}`);
		this._onAgentResumed.fire({ taskId });
	}

	stop(taskId: string): void {
		this._clearTimer(taskId);
		this._excluded.delete(taskId);
		this._logService.debug(`[VibeIDE DMS] Stopped for task ${taskId}`);
	}

	excludeFromTimer(taskId: string): void {
		this._excluded.add(taskId);
		this._clearTimer(taskId);
		this._logService.debug(`[VibeIDE DMS] Excluded task ${taskId} from timer (pre-flight or rate limit)`);
	}

	includeInTimer(taskId: string): void {
		this._excluded.delete(taskId);
		if (this._enabled) {
			this._scheduleTimer(taskId);
		}
		this._logService.debug(`[VibeIDE DMS] Re-included task ${taskId} in timer`);
	}

	private _scheduleTimer(taskId: string): void {
		const timer = setTimeout(() => {
			if (!this._excluded.has(taskId)) {
				this._logService.warn(`[VibeIDE DMS] ⏸ Agent paused — no approval for ${this._timeoutMs / 60000} minutes. Task: ${taskId}`);
				this._onAgentPaused.fire({
					taskId,
					reason: localize(
						'vibeDMSTimeout',
						'Agent paused: no confirmation received for {0} minutes. Click Approve to continue or Cancel to stop.',
						Math.round(this._timeoutMs / 60000)
					)
				});
			}
		}, this._timeoutMs);

		this._timers.set(taskId, timer);
	}

	private _clearTimer(taskId: string): void {
		const existing = this._timers.get(taskId);
		if (existing !== undefined) {
			clearTimeout(existing);
			this._timers.delete(taskId);
		}
	}

	override dispose(): void {
		for (const timer of this._timers.values()) {
			clearTimeout(timer);
		}
		this._timers.clear();
		super.dispose();
	}
}

registerSingleton(IVibeDeadMansSwitchService, VibeDeadMansSwitchService, InstantiationType.Eager);
