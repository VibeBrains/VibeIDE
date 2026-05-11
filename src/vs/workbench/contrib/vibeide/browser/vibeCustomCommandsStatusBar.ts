/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project Commands — status-bar indicator (`▶ N`).
 *
 * Subscribes to `IVibeCustomCommandsService.onDidStart/EndCommand`, tracks
 * running invocations in memory, and renders the pure-helper output
 * `buildProjectCommandsStatusBarState` through `IStatusbarService.addEntry`.
 * Click → open the run-from-palette Quick Pick (caller can re-run the same
 * command immediately).
 *
 * Hidden when 0 commands are running. Visible status-bar entry appears at
 * the LEFT alignment so it neighbours the chat-mode indicator without
 * fighting language-mode / encoding entries on the right.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';
import { buildProjectCommandsStatusBarState } from '../common/projectCommandsStatusBar.js';
import { PROJECT_COMMANDS_PALETTE_IDS } from '../common/projectCommandsServiceContract.js';

const STATUSBAR_ENTRY_ID = 'vibeide.commands.runningIndicator';

export class VibeCustomCommandsStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeCustomCommandsStatusBar';

	/** invocationId → name for live count + tooltip details. */
	private readonly _running = new Map<string, string>();
	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IVibeCustomCommandsService private readonly _commands: IVibeCustomCommandsService,
		@IStatusbarService private readonly _statusbar: IStatusbarService,
	) {
		super();
		this._register(this._commands.onDidStartCommand(e => {
			this._running.set(e.invocationId, e.name);
			this._refresh();
		}));
		this._register(this._commands.onDidEndCommand(e => {
			this._running.delete(e.invocationId);
			this._refresh();
		}));
		this._refresh();
	}

	private _refresh(): void {
		const state = buildProjectCommandsStatusBarState({
			runningCount: this._running.size,
			runningNames: Array.from(this._running.values()),
		});
		if (!state.visible) {
			this._entry.clear();
			return;
		}
		const props = {
			name: 'VibeIDE Project Commands',
			text: state.text,
			ariaLabel: state.tooltip,
			tooltip: state.tooltip,
			command: PROJECT_COMMANDS_PALETTE_IDS.run,
		};
		if (this._entry.value) {
			this._entry.value.update(props);
		} else {
			this._entry.value = this._statusbar.addEntry(props, STATUSBAR_ENTRY_ID, StatusbarAlignment.LEFT, 80);
		}
	}
}

registerWorkbenchContribution2(
	VibeCustomCommandsStatusBarContribution.ID,
	VibeCustomCommandsStatusBarContribution,
	WorkbenchPhase.AfterRestored,
);
