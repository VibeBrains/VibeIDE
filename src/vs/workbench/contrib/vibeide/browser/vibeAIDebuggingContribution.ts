/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * AI debugging context adapter (roadmap §L881).
 *
 * Subscribes to `IDebugService.onDidChangeBreakpoints` and `onDidChangeCallStack`,
 * collects the active session state, and translates it into `DebugSessionSnapshot`
 * via the pure helper `aiDebuggingContext.ts` so the agent can reference the current
 * breakpoint/variables context in its reasoning.
 *
 * Skeleton note: `buildDebugContextForAgent` produces fully-formed markdown, but the
 * hookup into the chat prompt pipeline (injecting as a system message segment) is
 * deferred — requires coordination with `chatThreadService._runChatAgent` context
 * assembly to avoid token bloat. For now this contribution keeps the snapshot fresh
 * and exposes it for inspection via `IVibeAIDebuggingService.getContextMarkdown()`.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDebugService, State as DebugState } from '../../debug/common/debug.js';
import {
	buildDebugContextForAgent,
	rankBreakpointsForAgent,
	BreakpointSnapshot,
	DebugSessionSnapshot,
	DebugContextForAgent,
	BreakpointPriority,
} from '../common/aiDebuggingContext.js';

export const IVibeAIDebuggingService = createDecorator<IVibeAIDebuggingService>('vibeAIDebuggingService');

export interface IVibeAIDebuggingService {
	readonly _serviceBrand: undefined;
	/** Latest debug context markdown for the agent, or empty string if no session active. */
	getContextMarkdown(): string;
	/** Fired when the debug context snapshot changes. */
	readonly onDidChangeContext: Event<void>;
}

class VibeAIDebuggingService extends Disposable implements IVibeAIDebuggingService {
	declare readonly _serviceBrand: undefined;

	private _lastContext: DebugContextForAgent | null = null;

	private readonly _onDidChangeContext = this._register(new Emitter<void>());
	readonly onDidChangeContext: Event<void> = this._onDidChangeContext.event;

	constructor(
		@IDebugService private readonly _debugService: IDebugService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		const model = this._debugService.getModel();
		this._register(model.onDidChangeBreakpoints(() => this._refresh()));
		this._register(model.onDidChangeCallStack(() => this._refresh()));
		this._register(this._debugService.onDidChangeState(s => {
			if (s === DebugState.Inactive) {
				this._lastContext = null;
				this._onDidChangeContext.fire();
			}
		}));
	}

	getContextMarkdown(): string {
		return this._lastContext?.markdownBody ?? '';
	}

	private _refresh(): void {
		if (this._debugService.state === DebugState.Inactive) {
			return;
		}
		try {
			const snap = this._buildSnapshot();
			if (!snap) { return; }
			this._lastContext = buildDebugContextForAgent(snap);
			this._onDidChangeContext.fire();
		} catch (e) {
			this._log.warn('[VibeAIDebugging] _refresh() failed:', e);
		}
	}

	private _buildSnapshot(): DebugSessionSnapshot | null {
		const model = this._debugService.getModel();
		const rawBps = model.getBreakpoints();
		if (rawBps.length === 0) { return null; }

		const bps: BreakpointSnapshot[] = rawBps.map(bp => ({
			id: bp.getId(),
			fileUri: bp.uri.toString(),
			line: bp.lineNumber,
			column: bp.column,
			condition: bp.condition,
			hitCount: 0,
			enabled: bp.enabled,
			verified: bp.verified,
		}));

		const ranked: readonly BreakpointPriority[] = rankBreakpointsForAgent(bps);
		const topId = ranked[0]?.id;
		const activeBreakpoint = topId ? bps.find(b => b.id === topId) : undefined;

		return {
			sessionId: 'active',
			threadId: 0,
			stoppedReason: undefined,
			frames: [],
			activeBreakpoint,
		};
	}
}

registerSingleton(IVibeAIDebuggingService, VibeAIDebuggingService, InstantiationType.Delayed);

export class VibeAIDebuggingContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeAIDebugging';

	constructor(
		@IVibeAIDebuggingService _service: IVibeAIDebuggingService,
	) {
		super();
		// Service is activated by DI; contribution exists to force eager instantiation.
	}
}

registerWorkbenchContribution2(
	VibeAIDebuggingContribution.ID,
	VibeAIDebuggingContribution,
	WorkbenchPhase.AfterRestored,
);
