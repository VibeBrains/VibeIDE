/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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

import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';
import { buildProjectCommandsStatusBarState } from '../common/projectCommandsStatusBar.js';
import { PROJECT_COMMANDS_PALETTE_IDS } from '../common/projectCommandsServiceContract.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

const STATUSBAR_ENTRY_ID = 'vibeide.commands.runningIndicator';

export class VibeCustomCommandsStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeCustomCommandsStatusBar';

	/** invocationId → name for live count + tooltip details. */
	private readonly _running = new Map<string, string>();
	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private _unifiedRow: IDisposable | undefined;

	constructor(
		@IVibeCustomCommandsService private readonly _commands: IVibeCustomCommandsService,
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
		@IConfigurationService private readonly _config: IConfigurationService,
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
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) {
				this._entry.clear();
				this._unifiedRow?.dispose();
				this._unifiedRow = undefined;
				this._refresh();
			}
		}));
		this._refresh();
	}

	private _refresh(): void {
		const state = buildProjectCommandsStatusBarState({
			runningCount: this._running.size,
			runningNames: Array.from(this._running.values()),
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
					tooltip: state.tooltip,
					counter: this._running.size,
					priority: 80,
					command: PROJECT_COMMANDS_PALETTE_IDS.run,
				});
			} else {
				this._unified.updateRow(STATUSBAR_ENTRY_ID, { label: state.text, tooltip: state.tooltip, counter: this._running.size });
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
			name: localize('vibeProjectCommandsStatusBarName', 'Пользовательские команды VibeIDE'),
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

	override dispose(): void {
		this._unifiedRow?.dispose();
		super.dispose();
	}
}

registerWorkbenchContribution2(
	VibeCustomCommandsStatusBarContribution.ID,
	VibeCustomCommandsStatusBarContribution,
	WorkbenchPhase.AfterRestored,
);
