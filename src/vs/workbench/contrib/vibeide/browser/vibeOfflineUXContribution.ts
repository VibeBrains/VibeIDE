/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
		if (typeof window === 'undefined') return;

		const onOffline = () => {
			this._showOfflineIndicator();
			this._notificationService.notify({
				severity: Severity.Warning,
				message: localize(
					'vibeOffline',
					'VibeIDE: Offline mode. AI features are unavailable. Ollama local models still work.'
				),
			});
		};

		const onOnline = () => {
			this._offlineEntry?.dispose();
			this._offlineEntry = undefined;
			this._notificationService.notify({
				severity: Severity.Info,
				message: localize('vibeOnline', 'VibeIDE: Back online. AI features restored.'),
			});
		};

		window.addEventListener('offline', onOffline);
		window.addEventListener('online', onOnline);

		this._register({ dispose: () => {
			window.removeEventListener('offline', onOffline);
			window.removeEventListener('online', onOnline);
		}});
	}

	private _showOfflineIndicator(): void {
		const props: IStatusbarEntry = {
			name: localize('vibeOfflineStatus', 'VibeIDE Offline'),
			text: '$(cloud-offline) Offline',
			tooltip: localize('vibeOfflineTooltip', 'VibeIDE is offline. Cloud AI unavailable. Ollama works locally.'),
			ariaLabel: localize('vibeOfflineStatusAria', 'VibeIDE is offline'),
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
