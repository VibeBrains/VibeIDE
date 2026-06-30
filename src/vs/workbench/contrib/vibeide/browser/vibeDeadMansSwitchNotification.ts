/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Wires the VibeDeadMansSwitchService to VS Code's notification system.
 *
 * The service itself fires onAgentPaused when no Approve action is received
 * within the configured timeout (default 5 min). This contribution listens to
 * that event and shows a sticky warning notification so the user knows the
 * agent is paused and waiting.
 *
 * Also imports the service module so its registerSingleton() side-effect runs.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IVibeDeadMansSwitchService } from './vibeDeadMansSwitchService.js';

class VibeDeadMansSwitchNotification extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeide.deadMansSwitchNotification';

	constructor(
		@IVibeDeadMansSwitchService private readonly _dmsService: IVibeDeadMansSwitchService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this._register(this._dmsService.onAgentPaused(({ reason }) => {
			this._notificationService.notify({
				severity: Severity.Warning,
				message: localize('vibeAgentPaused', 'Агент приостановлен: {0}', reason),
				sticky: true,
			});
		}));
	}
}

registerWorkbenchContribution2(
	VibeDeadMansSwitchNotification.ID,
	VibeDeadMansSwitchNotification,
	WorkbenchPhase.AfterRestored
);
