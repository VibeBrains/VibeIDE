/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Status-bar indicator for a running verify command (roadmap: VERIFY-GATE, «индикатор прогона»).
 *
 * The gate runs the project's build or test suite at the end of an agent turn — minutes, not
 * milliseconds — and did it silently. From the outside the IDE looked idle while a command was
 * holding the turn open, which reads as a hang: the one question the user has at that moment is
 * "is anything happening at all", and nothing on screen answered it.
 *
 * Shown only WHILE the command runs. A permanent entry saying "verify: enforce" would be a setting
 * rendered as an indicator — that belongs in settings, not in a place the eye scans for events.
 * The result already lands in the chat, so nothing lingers here after the run either.
 */

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { IVibeVerifyGateService } from './vibeVerifyGateService.js';

const ENTRY_ID = 'vibeide.verifyGate.running';

export class VibeVerifyGateStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeVerifyGateStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;
	private _unifiedRow: IDisposable | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IVibeVerifyGateService private readonly _verifyGate: IVibeVerifyGateService,
	) {
		super();
		this._register(this._verifyGate.onDidChangeRunning(running => this._wire(running)));
		// A running command survives a settings flip; re-wire so the indicator lands in whichever
		// surface the user just chose instead of disappearing until the next run.
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) { this._wire(this._verifyGate.isRunning); }
		}));
		this._wire(this._verifyGate.isRunning);
	}

	private _clear(): void {
		this._entry?.dispose();
		this._entry = undefined;
		this._unifiedRow?.dispose();
		this._unifiedRow = undefined;
	}

	private _wire(running: boolean): void {
		this._clear();
		if (!running) { return; }

		const text = localize('vibeide.verifyGate.sb.text', "$(sync~spin) проверка…");
		const tooltip = localize('vibeide.verifyGate.sb.tooltip', "Идёт проверка сборки/тестов перед завершением хода агента (команда `vibeide.agent.verifyGate.command`). Результат придёт в чат.");
		const unifiedOnly = this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		if (unifiedOnly) {
			this._unifiedRow = this._unified.registerRow({ id: ENTRY_ID, label: text, tooltip, priority: 169 });
			return;
		}
		this._entry = this._statusbarService.addEntry(
			{
				name: localize('vibeide.verifyGate.sb.name', "VibeIDE verify gate"),
				text,
				ariaLabel: localize('vibeide.verifyGate.sb.aria', "Идёт проверка сборки и тестов"),
				tooltip,
			},
			ENTRY_ID,
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 169 }, alignment: StatusbarAlignment.RIGHT }
		);
	}

	override dispose(): void {
		this._clear();
		super.dispose();
	}
}

registerWorkbenchContribution2(
	VibeVerifyGateStatusBarContribution.ID,
	VibeVerifyGateStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
