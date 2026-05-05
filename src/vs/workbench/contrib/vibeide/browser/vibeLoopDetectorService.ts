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
		@ILogService private readonly _logService: ILogService,
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
			this._logService.warn(`[VibeIDE LoopDetector] ⏸ ${message}`);
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
		if (history.length < this._threshold) return false;

		const recent = history.slice(-this._threshold);

		// Check 1: N+ consecutive identical actions (same type + target)
		const key = (a: AgentAction) => `${a.type}::${a.target}`;
		const firstKey = key(recent[0]);
		const allIdentical = recent.every(a => key(a) === firstKey);
		if (allIdentical) return true;

		// Check 2: Repeating A→B→A pattern (minimum 3 actions needed)
		if (history.length >= 3) {
			const last = history[history.length - 1];
			const thirdFromEnd = history[history.length - 3];
			const secondFromEnd = history[history.length - 2];
			if (key(last) === key(thirdFromEnd) && key(secondFromEnd) !== key(last)) {
				// A→B→A pattern detected
				return true;
			}
		}

		return false;
	}
}

registerSingleton(IVibeLoopDetectorService, VibeLoopDetectorService, InstantiationType.Eager);
