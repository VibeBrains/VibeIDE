/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';
import { IVibeContextFilterService } from '../common/vibeContextFilterService.js';
import { ContextFilterMode, decideContextFilterToast, describeContextFilterToast } from '../common/contextFilterToastPolicy.js';
import { COMMAND_OPEN_FULL_LOG, COMMAND_OPEN_SETTINGS } from './vibeContextFilterCommands.js';
import { IChatThreadService } from './chatThreadService.js';

/**
 * Surfaces a one-shot warning toast on the first auto-aggregation event of the
 * session. Gating logic lives in the pure helper `decideContextFilterToast`
 * (covered by 18 unit-tests). Per-session flag resets on chat-thread change so
 * a fresh thread re-arms the toast.
 */
export class VibeContextFilterToastContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeContextFilterToast';

	private _hasShownAutoAggregationToast = false;

	constructor(
		@IVibeContextFilterService private readonly _filter: IVibeContextFilterService,
		@INotificationService private readonly _notifications: INotificationService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@ICommandService private readonly _commands: ICommandService,
		@IChatThreadService private readonly _chatThread: IChatThreadService,
	) {
		super();
		this._register(this._filter.onDidCompact(({ ctxPct }) => this._onCompact(ctxPct)));
		this._register(this._chatThread.onDidChangeCurrentThread(() => {
			this._hasShownAutoAggregationToast = false;
		}));
	}

	private _onCompact(ctxPct: number): void {
		const mode = (this._config.getValue<ContextFilterMode>('vibeide.context.filterMode') ?? 'auto');
		const thresholdPctSetting = this._config.getValue<number>('vibeide.context.filterThresholdPct') ?? 70;
		const decision = decideContextFilterToast({
			mode,
			ctxPct,
			hasShownToastThisSession: this._hasShownAutoAggregationToast,
			threshold: thresholdPctSetting / 100,
		});
		if (!decision.emit) {
			return;
		}

		const message = describeContextFilterToast(decision.thresholdPct);
		const handle = this._notifications.notify({
			severity: Severity.Warning,
			message,
			sticky: true,
			actions: {
				primary: [
					{
						id: COMMAND_OPEN_FULL_LOG,
						enabled: true,
						label: localize('vibeide.contextFilter.toast.openFullLog', 'Открыть полный лог'),
						tooltip: '',
						class: undefined,
						run: async () => {
							try {
								await this._commands.executeCommand(COMMAND_OPEN_FULL_LOG);
							} finally {
								handle.close();
							}
						},
					},
					{
						id: COMMAND_OPEN_SETTINGS,
						enabled: true,
						label: localize('vibeide.contextFilter.toast.openSettings', 'Сменить режим в настройках'),
						tooltip: '',
						class: undefined,
						run: async () => {
							try {
								await this._commands.executeCommand(COMMAND_OPEN_SETTINGS);
							} finally {
								handle.close();
							}
						},
					},
				],
			},
		});
		this._hasShownAutoAggregationToast = true;
	}
}

registerWorkbenchContribution2(
	VibeContextFilterToastContribution.ID,
	VibeContextFilterToastContribution,
	WorkbenchPhase.AfterRestored,
);
