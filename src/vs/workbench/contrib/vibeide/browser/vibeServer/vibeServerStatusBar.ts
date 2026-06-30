/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Three-state status bar entry for Vibe Server: idle ("Go Live"), starting (spinner),
 * running (live URL). Clicking opens the preview when running, or starts the server when idle.
 */

import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IStatusbarService, IStatusbarEntry, IStatusbarEntryAccessor, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { IVibeServerService } from './vibeServerService.js';
import { VibeServerCommands, VibeServerConfigKeys } from './vibeServerConstants.js';

const STATUS_ID = 'vibeide.vibeServer.status';

export class VibeServerStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeServerStatusBar';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IVibeServerService private readonly _vibeServerService: IVibeServerService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._register(this._vibeServerService.onDidChangeStatus(() => this._render()));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VibeServerConfigKeys.showOnStatusbar)) {
				this._render();
			}
		}));
		this._render();
	}

	private _render(): void {
		if (this._configurationService.getValue<boolean>(VibeServerConfigKeys.showOnStatusbar) === false) {
			this._entry.clear();
			return;
		}
		const entry = this._buildEntry();
		if (this._entry.value) {
			this._entry.value.update(entry);
		} else {
			this._entry.value = this._statusbarService.addEntry(entry, STATUS_ID, StatusbarAlignment.RIGHT, 100);
		}
	}

	private _buildEntry(): IStatusbarEntry {
		const name = localize('vibeServer.statusName', "Vibe Server");
		const status = this._vibeServerService.status;
		if (status.state === 'running' && status.started) {
			const address = `${status.started.host}:${status.started.port}`;
			const problems = this._vibeServerService.problemCount();
			const badge = problems > 0 ? ` $(warning) ${problems}` : '';
			return {
				name,
				text: `$(zap) ${address}${badge}`,
				ariaLabel: localize('vibeServer.statusRunningAria', "Vibe Server запущен на {0}", address),
				tooltip: problems > 0
					? localize('vibeServer.statusRunningProblems', "Vibe Server запущен — {0} ошибок в превью; открыть превью", problems)
					: localize('vibeServer.statusRunningTooltip', "Vibe Server запущен — открыть превью"),
				command: VibeServerCommands.openPreview,
			};
		}
		if (status.state === 'starting') {
			return {
				name,
				text: `$(sync~spin) ${localize('vibeServer.statusStarting', "Запуск…")}`,
				ariaLabel: localize('vibeServer.statusStartingAria', "Vibe Server запускается"),
				tooltip: localize('vibeServer.statusStartingTooltip', "Vibe Server запускается"),
			};
		}
		return {
			name,
			text: `$(play-circle) ${localize('vibeServer.statusIdle', "Go Live")}`,
			ariaLabel: localize('vibeServer.statusIdleAria', "Запустить Vibe Server"),
			tooltip: localize('vibeServer.statusIdleTooltip', "Запустить Vibe Server"),
			command: VibeServerCommands.start,
		};
	}
}
