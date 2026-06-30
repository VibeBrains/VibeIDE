/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { INotificationActions, INotificationHandle, INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IMetricsService } from '../common/metricsService.js';
import { IVibeideUpdateService } from '../common/vibeideUpdateService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import * as dom from '../../../../base/browser/dom.js';
import { IUpdateService } from '../../../../platform/update/common/update.js';
import { VibeideCheckUpdateResponse } from '../common/vibeideUpdateServiceTypes.js';
import { IAction } from '../../../../base/common/actions.js';




const notifyUpdate = (res: VibeideCheckUpdateResponse & { message: string }, notifService: INotificationService, updateService: IUpdateService, vibeideUpdateService: IVibeideUpdateService, progressService: IProgressService): INotificationHandle => {
	const message = res?.message || 'This is a very old version. Please download the latest VibeIDE!';

	let actions: INotificationActions | undefined;

	if (res?.action) {
		const primary: IAction[] = [];

		if (res.action === 'reinstall') {
			primary.push({
				label: localize('vibeide.update.actionReinstall', 'Переустановить'),
				id: 'vibe.updater.reinstall',
				enabled: true,
				tooltip: '',
				class: undefined,
				run: async () => {
					if (res.verifiedDownload) {
						await progressService.withProgress({
							location: ProgressLocation.Notification,
							title: localize('vibeide.update.downloadInstallerProgress', 'Загрузка установщика VibeIDE…'),
						}, async () => {
							const r = await vibeideUpdateService.downloadVerifiedReleaseAsset(
								res.verifiedDownload!.url,
								res.verifiedDownload!.sha256,
								res.verifiedDownload!.fileName,
							);
							if (!r.ok) {
								notifService.notify({ severity: Severity.Error, message: r.message });
							}
						});
					} else {
						const { window } = dom.getActiveWindow();
						window.open('https://openvibeide.com');
					}
				}
			});
		}

		if (res.action === 'download') {
			primary.push({
				label: localize('vibeide.update.actionDownload', 'Скачать'),
				id: 'vibe.updater.download',
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => {
					updateService.downloadUpdate(true);
				}
			});
		}


		if (res.action === 'apply') {
			primary.push({
				label: localize('vibeide.update.actionApply', 'Применить'),
				id: 'vibe.updater.apply',
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => {
					updateService.applyUpdate();
				}
			});
		}

		if (res.action === 'restart') {
			primary.push({
				label: localize('vibeide.update.actionRestart', 'Перезапустить'),
				id: 'vibe.updater.restart',
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => {
					updateService.quitAndInstall();
				}
			});
		}

		primary.push({
			id: 'vibe.updater.site',
			enabled: true,
			label: localize('vibeide.update.actionOpenSite', 'Сайт VibeIDE'),
			tooltip: '',
			class: undefined,
			run: () => {
				const { window } = dom.getActiveWindow();
				window.open('https://openvibeide.com');
			}
		});

		actions = {
			primary: primary,
			secondary: [{
				id: 'vibe.updater.close',
				enabled: true,
				label: localize('vibeide.update.actionKeepVersion', 'Оставить текущую версию'),
				tooltip: '',
				class: undefined,
				run: () => {
					notifController.close();
				}
			}]
		};
	}
	else {
		actions = undefined;
	}

	const notifController = notifService.notify({
		severity: Severity.Info,
		message: message,
		sticky: true,
		progress: actions ? { worked: 0, total: 100 } : undefined,
		actions: actions,
	});

	return notifController;
	// const d = notifController.onDidClose(() => {
	// 	notifyYesUpdate(notifService, res)
	// 	d.dispose()
	// })
};
const notifyErrChecking = (notifService: INotificationService): INotificationHandle => {
	const message = `There was an error checking for updates. If this persists, please reinstall VibeIDE.`;
	const notifController = notifService.notify({
		severity: Severity.Info,
		message: message,
		sticky: true,
	});
	return notifController;
};


const performVibeCheck = async (
	explicit: boolean,
	notifService: INotificationService,
	vibeideUpdateService: IVibeideUpdateService,
	metricsService: IMetricsService,
	updateService: IUpdateService,
	progressService: IProgressService,
): Promise<INotificationHandle | null> => {

	const metricsTag = explicit ? 'Manual' : 'Auto';

	metricsService.capture(`VibeIDE Update ${metricsTag}: Checking...`, {});
	const res = await vibeideUpdateService.check(explicit);
	if (!res) {
		const notifController = notifyErrChecking(notifService);
		metricsService.capture(`VibeIDE Update ${metricsTag}: Error`, { res });
		return notifController;
	}
	else {
		if (res.message) {
			const notifController = notifyUpdate(res, notifService, updateService, vibeideUpdateService, progressService);
			metricsService.capture(`VibeIDE Update ${metricsTag}: Yes`, { res });
			return notifController;
		}
		else {
			metricsService.capture(`VibeIDE Update ${metricsTag}: No`, { res });
			return null;
		}
	}
};


// Action
let lastNotifController: INotificationHandle | null = null;


registerAction2(class extends Action2 {
	constructor() {
		super({
			f1: true,
			id: 'vibe.checkUpdate',
			title: localize2('vibeCheckUpdate', 'VibeIDE: проверить наличие обновлений'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const vibeideUpdateService = accessor.get(IVibeideUpdateService);
		const notifService = accessor.get(INotificationService);
		const metricsService = accessor.get(IMetricsService);
		const updateService = accessor.get(IUpdateService);
		const progressService = accessor.get(IProgressService);

		const currNotifController = lastNotifController;

		const newController = await performVibeCheck(true, notifService, vibeideUpdateService, metricsService, updateService, progressService);

		if (newController) {
			currNotifController?.close();
			lastNotifController = newController;
		}
	}
});

// on mount
class VibeUpdateWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibe.update';
	constructor(
		@IVibeideUpdateService vibeideUpdateService: IVibeideUpdateService,
		@IMetricsService metricsService: IMetricsService,
		@INotificationService notifService: INotificationService,
		@IUpdateService updateService: IUpdateService,
		@IProgressService progressService: IProgressService,
	) {
		super();

		const autoCheck = () => {
			performVibeCheck(false, notifService, vibeideUpdateService, metricsService, updateService, progressService);
		};

		// check once 5 seconds after mount
		// check every 3 hours
		const { window } = dom.getActiveWindow();

		const initId = window.setTimeout(() => autoCheck(), 5 * 1000);
		this._register({ dispose: () => window.clearTimeout(initId) });


		const intervalId = window.setInterval(() => autoCheck(), 3 * 60 * 60 * 1000); // every 3 hrs
		this._register({ dispose: () => window.clearInterval(intervalId) });

	}
}
registerWorkbenchContribution2(VibeUpdateWorkbenchContribution.ID, VibeUpdateWorkbenchContribution, WorkbenchPhase.BlockRestore);
