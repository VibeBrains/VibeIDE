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
// Surface the loop-detector threshold in VS Code's Settings UI. Without this
// block the key read by the constructor exists only via the `?? 3` fallback,
// so users never see it in the editor and can't tune sensitivity without
// editing settings.json by hand.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.safety.loopDetectorThreshold': {
			type: 'number',
			default: 3,
			minimum: 2,
			maximum: 20,
			description: localize('vibeide.safety.loopDetectorThreshold', 'Сколько повторений одинакового `(type, target)` действия (или цикла `A→B→A`) подряд триггерят auto-pause агентской сессии. Минимум 2 (1 не имеет смысла как loop). Default 3.'),
		},
	},
});

export interface AgentAction {
	type: string;       // Action type: 'write_file', 'run_command', 'read_file', etc.
	target: string;     // Target: file path, command string, etc.
	isRepairLoopStep?: boolean; // Auto-repair loop steps are excluded from loop detection
	taskDecompositionStep?: boolean; // Task decomposition steps are excluded
}

export const IVibeLoopDetectorService = createDecorator<IVibeLoopDetectorService>('vibeLoopDetectorService');

export interface IVibeLoopDetectorService {
	readonly _serviceBrand: undefined;

	/** Record an agent action. Returns true if a loop was detected. */
	recordAction(sessionId: string, action: AgentAction): boolean;

	/** Get recent actions for display (last N) */
	getRecentActions(sessionId: string, count?: number): AgentAction[];

	/** Reset action history for a session */
	resetSession(sessionId: string): void;

	/** Event fired when a loop is detected */
	readonly onLoopDetected: Event<{ sessionId: string; actions: AgentAction[]; message: string }>;
}

/**
 * Pure helper. Returns true iff the trailing window of `history` is a loop:
 *   - the last `threshold` actions are identical by (type, target), OR
 *   - last three actions form an A → B → A pattern (only when history.length >= 3).
 *
 * Excluded actions (isRepairLoopStep / taskDecompositionStep) must already be filtered
 * out by the caller. No DI dependencies — this is a pure function from history shape.
 */
export function detectLoopInHistory(history: AgentAction[], threshold: number): boolean {
	if (history.length < threshold) {
		return false;
	}
	const key = (a: AgentAction) => `${a.type}::${a.target}`;
	const recent = history.slice(-threshold);
	const firstKey = key(recent[0]);
	const allIdentical = recent.every(a => key(a) === firstKey);
	if (allIdentical) {
		return true;
	}
	if (history.length >= 3) {
		const last = history[history.length - 1];
		const second = history[history.length - 2];
		const third = history[history.length - 3];
		if (key(last) === key(third) && key(second) !== key(last)) {
			return true;
		}
	}
	return false;
}

/**
 * VibeIDE Loop Detector: auto-pauses agent when 3+ identical actions in a row.
 *
 * Definition of "identical": (type + target) repeated consecutively.
 * OR: repeating sequence A→B→A.
 *
 * Excluded from detection:
 *   - Auto-repair loop steps (isRepairLoopStep: true)
 *   - Task decomposition steps (taskDecompositionStep: true)
 */
class VibeLoopDetectorService extends Disposable implements IVibeLoopDetectorService {
	declare readonly _serviceBrand: undefined;

	private readonly _onLoopDetected = this._register(new Emitter<{ sessionId: string; actions: AgentAction[]; message: string }>());
	readonly onLoopDetected = this._onLoopDetected.event;

	private readonly _actionHistory = new Map<string, AgentAction[]>();
	private _threshold: number;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._threshold = this._configurationService.getValue<number>('vibeide.safety.loopDetectorThreshold') ?? 3;

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.safety.loopDetectorThreshold')) {
				this._threshold = this._configurationService.getValue<number>('vibeide.safety.loopDetectorThreshold') ?? 3;
			}
		}));
	}

	recordAction(sessionId: string, action: AgentAction): boolean {
		// Excluded actions never trigger loop detection
		if (action.isRepairLoopStep || action.taskDecompositionStep) {
			return false;
		}

		const history = this._actionHistory.get(sessionId) ?? [];
		history.push(action);

		// Keep only recent history (last 20 actions)
		if (history.length > 20) {
			history.shift();
		}
		this._actionHistory.set(sessionId, history);

		const loopDetected = this._checkForLoop(history);
		if (loopDetected) {
			const recent = history.slice(-Math.min(5, history.length));
			const message = `Loop detected: action "${action.type}:${action.target}" repeated ${this._threshold}+ times consecutively.`;
			vibeLog.warn('LoopDetector', `⏸ ${message}`);
			this._onLoopDetected.fire({ sessionId, actions: recent, message });
		}

		return loopDetected;
	}

	getRecentActions(sessionId: string, count: number = 5): AgentAction[] {
		const history = this._actionHistory.get(sessionId) ?? [];
		return history.slice(-count);
	}

	resetSession(sessionId: string): void {
		this._actionHistory.delete(sessionId);
	}

	private _checkForLoop(history: AgentAction[]): boolean {
		return detectLoopInHistory(history, this._threshold);
	}
}

registerSingleton(IVibeLoopDetectorService, VibeLoopDetectorService, InstantiationType.Eager);
