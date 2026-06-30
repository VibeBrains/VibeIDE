/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `vibeide.watchdog.bundleCrashReport` — Action2 for manually exporting a
 * watchdog crash report ZIP (roadmap W.11).
 *
 * The same bundle that pre-flight notification can produce — provided as a
 * Command Palette entry so power users can capture state at any time, not
 * only after a crash.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { IVibeIdleWatchdogProxy } from '../common/vibeIdleWatchdogProxy.js';

class VibeIdleWatchdogBundleAction extends Action2 {
	static readonly ID = 'vibeide.watchdog.bundleCrashReport';

	constructor() {
		super({
			id: VibeIdleWatchdogBundleAction.ID,
			title: localize2('vibeide.watchdog.bundleCrashReport.title', 'Собрать crash report (Idle Watchdog)'),
			category: { value: 'VibeIDE Diagnostics', original: 'VibeIDE Diagnostics' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const proxy = accessor.get(IVibeIdleWatchdogProxy);
		const notifications = accessor.get(INotificationService);
		const fileDialog = accessor.get(IFileDialogService);

		const defaultFolder = await fileDialog.defaultFilePath('file');
		// `URI.joinPath` resolves to correct path separator per platform — string
		// concatenation `defaultUri.fsPath + '/vibeide-crash-report.zip'` (pre-W.22)
		// produced mixed `\` and `/` on Windows.
		const defaultUri = defaultFolder ? joinPath(defaultFolder, 'vibeide-crash-report.zip') : undefined;
		const target = await fileDialog.showSaveDialog({
			title: localize('vibeide.watchdog.bundle.saveTitle', 'Сохранить crash report'),
			defaultUri,
			filters: [{ name: 'ZIP', extensions: ['zip'] }],
		});
		if (!target) { return; }
		try {
			const result = await proxy.bundleCrashReport(target.fsPath);
			notifications.notify({
				severity: Severity.Info,
				message: localize(
					'vibeide.watchdog.bundle.done',
					'Crash report сохранён ({0} файл(ов), {1} МБ): {2}',
					result.fileCount,
					(result.sizeBytes / (1024 * 1024)).toFixed(1),
					result.outputPath,
				),
			});
		} catch (e) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize(
					'vibeide.watchdog.bundle.failed',
					'Не удалось собрать crash report: {0}',
					e instanceof Error ? e.message : String(e),
				),
			});
		}
	}
}

registerAction2(VibeIdleWatchdogBundleAction);
