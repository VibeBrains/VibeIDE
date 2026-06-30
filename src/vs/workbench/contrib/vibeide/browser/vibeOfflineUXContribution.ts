/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

/**
 * VibeIDE Offline-first UX.
 * - Detects network status changes
 * - Shows clear indicator when working offline
 * - Queues sync operations for reconnection
 */
export class VibeOfflineUXContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeOfflineUX';

	private _offlineEntry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this._setupNetworkMonitoring();
	}

	private _setupNetworkMonitoring(): void {
		if (typeof mainWindow === 'undefined') { return; }

		const onOffline = () => {
			this._showOfflineIndicator();
			this._notificationService.notify({
				severity: Severity.Warning,
				message: localize(
					'vibeOffline',
					'VibeIDE: Режим офлайн. Функции AI недоступны. Локальные модели Ollama продолжают работать.'
				),
			});
		};

		const onOnline = () => {
			this._offlineEntry?.dispose();
			this._offlineEntry = undefined;
			this._notificationService.notify({
				severity: Severity.Info,
				message: localize('vibeOnline', 'VibeIDE: Соединение восстановлено. Функции AI снова доступны.'),
			});
		};

		mainWindow.addEventListener('offline', onOffline);
		mainWindow.addEventListener('online', onOnline);

		this._register({
			dispose: () => {
				mainWindow.removeEventListener('offline', onOffline);
				mainWindow.removeEventListener('online', onOnline);
			}
		});
	}

	private _showOfflineIndicator(): void {
		const props: IStatusbarEntry = {
			name: localize('vibeOfflineStatus', 'VibeIDE офлайн'),
			text: `$(cloud-offline) ${localize('vibeOfflineStatusText', 'Офлайн')}`,
			tooltip: localize('vibeOfflineTooltip', 'VibeIDE офлайн. Облачный AI недоступен. Ollama работает локально.'),
			ariaLabel: localize('vibeOfflineStatusAria', 'VibeIDE работает офлайн'),
		};

		this._offlineEntry = this._statusbarService.addEntry(
			props,
			'vibeide.offline',
			StatusbarAlignment.LEFT,
			{ location: { id: 'status.host', priority: 1000 }, alignment: StatusbarAlignment.LEFT }
		);
	}
}

registerWorkbenchContribution2(
	VibeOfflineUXContribution.ID,
	VibeOfflineUXContribution,
	WorkbenchPhase.AfterRestored
);
