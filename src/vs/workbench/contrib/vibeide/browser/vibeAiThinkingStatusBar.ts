/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * AI thinking indicator — status-bar contribution (roadmap L290).
 *
 * Maps `IChatThreadService.streamState` to `ThinkingPhase` and renders
 * `buildThinkingIndicator()` in the LEFT status bar. The entry is hidden
 * when no request is active, so it never competes with baseline IDE chrome.
 *
 * Phase mapping:
 *   LLM / preparing / tool   → 'thinking'
 *   awaiting_user / idle      → 'idle' (hidden)
 *   undefined with error      → 'failed'
 *
 * `lastChunkAgoMs` is approximated via a 1-second tick that measures elapsed
 * time since the last stream-state change. Sufficient for the UI hint level.
 */

import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IChatThreadService } from './chatThreadService.js';
import { buildThinkingIndicator, ThinkingPhase } from '../common/aiThinkingIndicator.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { mainWindow } from '../../../../base/browser/window.js';

const STATUSBAR_ENTRY_ID = 'vibeide.aiThinkingIndicator';
const TICK_MS = 1_000;

export class VibeAiThinkingStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeAiThinkingStatusBar';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private _unifiedRow: IDisposable | undefined;
	private _phase: ThinkingPhase = 'idle';
	private _phaseStartMs = 0;
	private _tickHandle: number | undefined;

	constructor(
		@IChatThreadService private readonly _chat: IChatThreadService,
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
		this._register(this._chat.onDidChangeStreamState(() => {
			this._syncPhase();
		}));
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) {
				this._entry.clear();
				this._unifiedRow?.dispose();
				this._unifiedRow = undefined;
				this._render();
			}
		}));
		this._syncPhase();
	}

	private _syncPhase(): void {
		const streamState = this._chat.streamState;
		let newPhase: ThinkingPhase = 'idle';

		for (const threadState of Object.values(streamState)) {
			if (!threadState) { continue; }
			const running = threadState.isRunning;
			if (running === 'LLM' || running === 'preparing' || running === 'tool') {
				newPhase = 'thinking';
				break;
			}
			if (running === undefined && threadState.error) {
				newPhase = 'failed';
				break;
			}
		}

		if (newPhase !== this._phase) {
			this._phase = newPhase;
			this._phaseStartMs = Date.now();
		}

		this._startOrStopTick();
		this._render();
	}

	private _startOrStopTick(): void {
		if (this._phase === 'idle' || this._phase === 'completed') {
			if (this._tickHandle !== undefined) {
				mainWindow.clearInterval(this._tickHandle);
				this._tickHandle = undefined;
			}
		} else if (this._tickHandle === undefined) {
			this._tickHandle = mainWindow.setInterval(() => this._render(), TICK_MS);
		}
	}

	private _render(): void {
		const state = buildThinkingIndicator({
			phase: this._phase,
			lastChunkAgoMs: this._phaseStartMs > 0 ? Date.now() - this._phaseStartMs : undefined,
		});

		const unifiedOnly = this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		if (unifiedOnly) {
			this._entry.clear();
			if (!state.visible) {
				this._unifiedRow?.dispose();
				this._unifiedRow = undefined;
				return;
			}
			if (!this._unifiedRow) {
				this._unifiedRow = this._unified.registerRow({
					id: STATUSBAR_ENTRY_ID,
					label: state.text,
					tooltip: state.hint,
					priority: 90,
				});
			} else {
				this._unified.updateRow(STATUSBAR_ENTRY_ID, { label: state.text, tooltip: state.hint });
			}
			return;
		}

		this._unifiedRow?.dispose();
		this._unifiedRow = undefined;

		if (!state.visible) {
			this._entry.clear();
			return;
		}

		const props = {
			name: localize('vibeAiThinkingStatusBarName', 'VibeIDE — думает ИИ'),
			text: state.text,
			ariaLabel: state.hint ?? state.text,
			tooltip: state.hint,
		};

		if (this._entry.value) {
			this._entry.value.update(props);
		} else {
			this._entry.value = this._statusbar.addEntry(props, STATUSBAR_ENTRY_ID, StatusbarAlignment.LEFT, 90);
		}
	}

	override dispose(): void {
		if (this._tickHandle !== undefined) {
			mainWindow.clearInterval(this._tickHandle);
		}
		this._unifiedRow?.dispose();
		super.dispose();
	}
}

registerWorkbenchContribution2(
	VibeAiThinkingStatusBarContribution.ID,
	VibeAiThinkingStatusBarContribution,
	WorkbenchPhase.AfterRestored,
);
