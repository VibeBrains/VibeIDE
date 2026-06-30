/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';

import { localize } from '../../../../nls.js';
import { IVibeAgentTaskQueueService } from './vibeAgentTaskQueueService.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface the token-budget safety knobs in VS Code's Settings UI. Without this
// block all three keys read below by the constructor exist only via the `??`
// defaults, so users never see them in the editor and can't adjust the
// per-session token cap without editing settings.json by hand. Defaults match
// the in-code fallbacks (and `DEFAULT_TOKEN_LIMIT` below).

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.safety.sessionTokenLimitEnabled': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.safety.sessionTokenLimitEnabled', 'Включить per-session лимит токенов как safety guard. При превышении агентский запрос блокируется до явного reset через action в warning toast. Отключение полностью снимает session-level token gate (per-task split всё ещё применяется, если включён).'),
		},
		'vibeide.safety.sessionTokenLimit': {
			type: 'number',
			default: 2_000_000,
			minimum: 10_000,
			maximum: 100_000_000,
			description: localize('vibeide.safety.sessionTokenLimit', 'Максимум input+output токенов на одну chat-сессию (default 2 000 000 — рассчитан на длинные autopilot-сессии без постоянных сбросов). Применяется только когда `sessionTokenLimitEnabled` = true. Если включён `chatAgentAutopilot`, превышение лимита НЕ блокирует запрос: счётчик сбрасывается автоматически с записью в лог.'),
		},
		'vibeide.safety.taskQueueTokenSplitEnabled': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.safety.taskQueueTokenSplitEnabled', 'Делить session-лимит между активными задачами очереди (`IVibeAgentTaskQueueService`) пропорционально, чтобы одна задача не съела весь budget. Off-by-default: для одно-таскового флоу не нужен.'),
		},
		'vibeide.safety.sessionTokenWarningBlink': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.safety.sessionTokenWarningBlink', 'При приближении к лимиту токенов сессии (≥80%) подсвечивать жёлтым и мигать строкой времени последнего ответа в чате — вместо тоста на каждый warning. Логи при этом пишутся как обычно. Выключите, если мигание мешает.'),
		},
	},
});

export interface TokenBudgetStatus {
	sessionTokensUsed: number;
	sessionTokensLimit: number;
	percentUsed: number;
	isExceeded: boolean;
	isWarning: boolean; // >80% used
}

export const IVibeTokenBudgetService = createDecorator<IVibeTokenBudgetService>('vibeTokenBudgetService');

export interface IVibeTokenBudgetService {
	readonly _serviceBrand: undefined;

	/** Current session token usage status */
	getStatus(): TokenBudgetStatus;

	/** Record token usage from an LLM response */
	recordUsage(inputTokens: number, outputTokens: number, cachedInputTokens?: number): void;

	/** Check if budget is exceeded — throws if so */
	checkBudget(): void;

	/** Reset session token counter (new session) */
	resetSession(): void;

	/**
	 * When task-queue token split is enabled: attribute usage to this queued/running task id.
	 * Cleared automatically when the task reaches a terminal status (via task queue events).
	 * Integrations (agent runner) may override explicitly.
	 */
	setActiveQueueTaskId(taskId: string | undefined): void;

	/** Event fired when budget status changes */
	readonly onBudgetStatusChanged: Event<TokenBudgetStatus>;
}

/**
 * Pure helper. Compute a TokenBudgetStatus snapshot from the current `used` count,
 * the configured `limit`, and whether the guard is `enabled`. When `enabled === false`,
 * `isExceeded` and `isWarning` always return false even if the count is over the limit
 * (the guard does not block when disabled).
 */
export function computeBudgetStatus(used: number, limit: number, enabled: boolean): TokenBudgetStatus {
	const percentUsed = limit > 0 ? (used / limit) * 100 : 0;
	return {
		sessionTokensUsed: used,
		sessionTokensLimit: limit,
		percentUsed,
		isExceeded: enabled && used >= limit,
		isWarning: enabled && percentUsed >= 80,
	};
}

/**
 * Pure helper. Folds an LLM usage report into the running session counter, clamping
 * negative values to zero. Returns the new running total.
 */
export function accumulateUsage(prev: number, inputTokens: number, outputTokens: number): number {
	return prev + Math.max(0, inputTokens) + Math.max(0, outputTokens);
}

/**
 * VibeIDE: Session token budget enforcement.
 * Default limit: 2,000,000 tokens per session (autopilot-friendly).
 * Prevents runaway agents from generating unexpected costs while keeping headroom
 * for long autonomous runs. When `chatAgentAutopilot` is on, hitting the cap
 * auto-resets the counter instead of throwing — the user has already opted into
 * unattended execution and we should not stop the run for a confirm dialog.
 */
class VibeTokenBudgetService extends Disposable implements IVibeTokenBudgetService {
	declare readonly _serviceBrand: undefined;

	private readonly _onBudgetStatusChanged = this._register(new Emitter<TokenBudgetStatus>());
	readonly onBudgetStatusChanged = this._onBudgetStatusChanged.event;

	private _sessionTokensUsed = 0;
	private _sessionTokensLimit: number;
	private _enabled: boolean;
	private _splitEnabled: boolean;

	private _activeQueueTaskId: string | undefined;
	private readonly _perTaskTokens = new Map<string, number>();
	// Soft cooldown so a runaway loop in autopilot doesn't auto-reset hundreds of times per second.
	private _lastAutopilotResetAt = 0;
	private static readonly AUTOPILOT_RESET_COOLDOWN_MS = 1_000;

	// Default: 2M tokens per session — chosen so autopilot sessions don't hit the cap on routine work.
	private static readonly DEFAULT_TOKEN_LIMIT = 2_000_000;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IVibeAgentTaskQueueService private readonly _taskQueue: IVibeAgentTaskQueueService,
		@IVibeideSettingsService private readonly _vibeideSettingsService: IVibeideSettingsService,
	) {
		super();
		this._sessionTokensLimit = this._configurationService.getValue<number>('vibeide.safety.sessionTokenLimit')
			?? VibeTokenBudgetService.DEFAULT_TOKEN_LIMIT;
		this._enabled = this._configurationService.getValue<boolean>('vibeide.safety.sessionTokenLimitEnabled')
			?? true;
		this._splitEnabled = this._configurationService.getValue<boolean>('vibeide.safety.taskQueueTokenSplitEnabled')
			?? false;

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.safety.sessionTokenLimit') || e.affectsConfiguration('vibeide.safety.sessionTokenLimitEnabled')) {
				this._sessionTokensLimit = this._configurationService.getValue<number>('vibeide.safety.sessionTokenLimit')
					?? VibeTokenBudgetService.DEFAULT_TOKEN_LIMIT;
				this._enabled = this._configurationService.getValue<boolean>('vibeide.safety.sessionTokenLimitEnabled')
					?? true;
			}
			if (e.affectsConfiguration('vibeide.safety.taskQueueTokenSplitEnabled')) {
				this._splitEnabled = this._configurationService.getValue<boolean>('vibeide.safety.taskQueueTokenSplitEnabled')
					?? false;
			}
		}));

		this._register(this._taskQueue.onTaskStatusChanged(t => {
			if (t.status === 'running') {
				this._activeQueueTaskId = t.id;
			}
			if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
				this._perTaskTokens.delete(t.id);
				if (this._activeQueueTaskId === t.id) {
					this._activeQueueTaskId = undefined;
				}
			}
		}));
	}

	setActiveQueueTaskId(taskId: string | undefined): void {
		this._activeQueueTaskId = taskId;
	}

	getStatus(): TokenBudgetStatus {
		return computeBudgetStatus(this._sessionTokensUsed, this._sessionTokensLimit, this._enabled);
	}

	recordUsage(inputTokens: number, outputTokens: number, cachedInputTokens?: number): void {
		const previous = this._sessionTokensUsed;
		this._sessionTokensUsed = accumulateUsage(previous, inputTokens, outputTokens);
		const total = this._sessionTokensUsed - previous;

		if (this._splitEnabled && this._activeQueueTaskId && total > 0) {
			const id = this._activeQueueTaskId;
			this._perTaskTokens.set(id, (this._perTaskTokens.get(id) ?? 0) + total);
		}

		// `cached:` — provider-reported prompt-cache hits (subset of `in:`). Visibility metric
		// for cache-friendly prompt assembly (knowledge/roadmap/token-economy.md, A).
		const cachedSuffix = typeof cachedInputTokens === 'number' && cachedInputTokens > 0 ? ` cached:${cachedInputTokens}` : '';
		vibeLog.debug('TokenBudget', `+${total} tokens (in:${inputTokens} out:${outputTokens}${cachedSuffix}) | total: ${this._sessionTokensUsed}/${this._sessionTokensLimit}`);

		const status = this.getStatus();
		this._onBudgetStatusChanged.fire(status);

		if (status.isWarning && !status.isExceeded) {
			vibeLog.warn('TokenBudget', `⚠️ Warning: ${status.percentUsed.toFixed(0)}% of session token limit used (${this._sessionTokensUsed.toLocaleString()}/${this._sessionTokensLimit.toLocaleString()})`);
		}
	}

	checkBudget(): void {
		if (!this._enabled) { return; }
		const status = this.getStatus();
		if (status.isExceeded) {
			// Autopilot mode: user has opted into unattended execution. Throwing here would
			// freeze the run waiting for a manual reset. Auto-reset with a clear log entry
			// instead, but rate-limit to avoid pathological loops resetting every iteration.
			const autopilotOn = this._vibeideSettingsService.state.globalSettings.chatAgentAutopilot === true;
			if (autopilotOn) {
				const now = Date.now();
				if (now - this._lastAutopilotResetAt >= VibeTokenBudgetService.AUTOPILOT_RESET_COOLDOWN_MS) {
					this._lastAutopilotResetAt = now;
					vibeLog.warn(
						'TokenBudget', `Autopilot auto-reset: session reached ${this._sessionTokensUsed.toLocaleString()}/${this._sessionTokensLimit.toLocaleString()} tokens. Counter cleared, run continues.`
					);
					this.resetSession();
					return;
				}
				// Inside cooldown: behave as if budget is still ok rather than throwing — autopilot must not stall.
				return;
			}
			throw new Error(
				localize(
					'vibeTokenBudgetExceeded',
					'Session token limit reached ({0} tokens used, limit: {1}). To continue, reset the session or increase the limit in Settings → VibeIDE → Safety.',
					this._sessionTokensUsed.toLocaleString(),
					this._sessionTokensLimit.toLocaleString()
				)
			);
		}

		if (this._splitEnabled && this._activeQueueTaskId) {
			const sliceCount = this._taskQueue.getTasks().filter(t => t.status === 'queued' || t.status === 'running').length;
			if (sliceCount >= 2) {
				const perLimit = Math.max(1, Math.floor(this._sessionTokensLimit / sliceCount));
				const usedSlice = this._perTaskTokens.get(this._activeQueueTaskId) ?? 0;
				if (usedSlice >= perLimit) {
					throw new Error(
						localize(
							'vibeTokenBudgetSliceExceeded',
							'Token budget slice for this task is exhausted (~{0} tokens per task while {1} tasks are queued or running). Finish or cancel queued tasks, disable task queue split in Settings, or raise the session limit.',
							perLimit.toLocaleString(),
							String(sliceCount)
						)
					);
				}
			}
		}
	}

	resetSession(): void {
		const prev = this._sessionTokensUsed;
		this._sessionTokensUsed = 0;
		this._perTaskTokens.clear();
		this._activeQueueTaskId = undefined;
		vibeLog.info('TokenBudget', `Session reset. Previous usage: ${prev.toLocaleString()} tokens`);
		this._onBudgetStatusChanged.fire(this.getStatus());
	}
}

registerSingleton(IVibeTokenBudgetService, VibeTokenBudgetService, InstantiationType.Eager);
