/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export interface DebugState {
	callStack: Array<{ name: string; file: string; line: number }>;
	variables: Record<string, unknown>;
	watchExpressions: Record<string, unknown>;
	currentFile?: string;
	currentLine?: number;
	pausedAt?: string; // breakpoint description
}

export const IVibeAIDebuggingService = createDecorator<IVibeAIDebuggingService>('vibeAIDebuggingService');

export interface IVibeAIDebuggingService {
	readonly _serviceBrand: undefined;

	/** Whether AI debugging is available (requires active debug session) */
	isAvailable(): boolean;

	/** Get current debugger state for agent context */
	getCurrentState(): DebugState | null;

	/** Notify agent of current debug state */
	shareStateWithAgent(state: DebugState): void;

	readonly onDebugStateShared: Event<DebugState>;
}

/**
 * VibeIDE AI Debugging Integration.
 * Agent sees debugger state: call stack, variables, watch expressions.
 * Closes debugging loop without manual copy-paste.
 * "Agent doesn't know WHERE it crashed, only WHAT crashed."
 *
 * Phase 3b implementation — requires VS Code debug API integration.
 */
class VibeAIDebuggingService extends Disposable implements IVibeAIDebuggingService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDebugStateShared = this._register(new Emitter<DebugState>());
	readonly onDebugStateShared = this._onDebugStateShared.event;

	private _currentState: DebugState | null = null;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	isAvailable(): boolean {
		// Phase 3b: check for active VS Code debug session
		return false;
	}

	getCurrentState(): DebugState | null {
		return this._currentState;
	}

	shareStateWithAgent(state: DebugState): void {
		this._currentState = state;
		this._onDebugStateShared.fire(state);
		this._logService.debug(`[VibeIDE AIDebug] State shared: ${state.callStack.length} frames, ${Object.keys(state.variables).length} vars`);
	}
}

registerSingleton(IVibeAIDebuggingService, VibeAIDebuggingService, InstantiationType.Delayed);
