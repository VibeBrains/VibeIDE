/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { vibeLog } from '../common/vibeLog.js';
import { IVibeNotifySoundService } from './vibeNotifySoundService.js';

// Lets the user hear the currently-selected notification sound from the command palette.
// The richer per-variant click-preview lives in the settings UI (Уведомления) and the «VibeIDE Звуки» editor.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.notify.sound.preview',
			title: localize2('vibeide.notify.sound.preview', 'Прослушать звук уведомления'),
			category: localize2('vibeide.notify.category', 'VibeIDE'),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IVibeNotifySoundService).preview();
	}
});

// On startup, if the selected sound is a custom file that no longer exists (deleted / moved / on an
// unmounted drive), fall back to the default and tell the user — so the picker never points at a
// missing file and playback never silently no-ops. Read is wrapped so a stat error can't crash boot.
class VibeNotifySoundStartupCheckContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeNotifySoundStartupCheck';

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		void this._check();
	}

	private async _check(): Promise<void> {
		try {
			if (this._configurationService.getValue<string>('vibeide.notify.sound.sound') !== 'custom') { return; }
			const path = this._configurationService.getValue<string>('vibeide.notify.sound.customPath');
			if (!path || typeof path !== 'string' || path.trim().length === 0) { return; }

			let exists = false;
			try { exists = await this._fileService.exists(URI.file(path)); } catch { exists = false; }
			if (exists) { return; }

			await this._configurationService.updateValue('vibeide.notify.sound.sound', 'taskCompleted');
			this._notificationService.notify({
				severity: Severity.Warning,
				message: localize('vibeide.notify.sound.missing', 'Выбранный звук уведомления не найден по пути «{0}». Включён стандартный звук.', path),
			});
		} catch (err) {
			vibeLog.warn('notifySound', `startup sound check failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

registerWorkbenchContribution2(
	VibeNotifySoundStartupCheckContribution.ID,
	VibeNotifySoundStartupCheckContribution,
	WorkbenchPhase.Eventually,
);
