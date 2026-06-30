/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeIDE installer fallback UX (roadmap §L953).
 *
 * When the silent installer is not available (SmartScreen / unsigned build),
 * this command copies the platform-specific CLI install command to the
 * clipboard and shows a toast so the user can paste it into a terminal.
 *
 * Uses `buildInstallerCommand` + `detectInstallerOS` from the pure helper
 * `common/installerCommandPicker.ts`.
 *
 * The command `vibeide.installer.copyCommand` accepts an optional argument:
 *   { filePath?: string }  — the absolute path to the installer file.
 * When omitted, it falls back to a Quick Open prompt.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { localize } from '../../../../nls.js';
import { buildInstallerCommand, detectInstallerOS } from '../common/installerCommandPicker.js';
import { extname } from '../../../../base/common/path.js';

registerAction2(class VibeInstallerCopyCommand extends Action2 {
	constructor() {
		super({
			id: 'vibeide.installer.copyCommand',
			title: { value: 'VibeIDE: Copy Installer Command to Clipboard', original: 'VibeIDE: Copy Installer Command to Clipboard' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, args?: { filePath?: string }): Promise<void> {
		const clipboard = accessor.get(IClipboardService);
		const notifications = accessor.get(INotificationService);
		const quickInput = accessor.get(IQuickInputService);

		let filePath = args?.filePath;
		if (!filePath) {
			filePath = await quickInput.input({
				placeHolder: localize('vibeide.installer.copyCommand.placeholder', 'Путь к файлу инсталлятора (например, C:\\VibeIDE-Setup.exe)'),
				prompt: localize('vibeide.installer.copyCommand.prompt', 'Введите полный путь к скачанному инсталлятору'),
				validateInput: async v => v.trim().length === 0
					? localize('vibeide.installer.copyCommand.emptyPath', 'Путь не может быть пустым')
					: null,
			});
		}

		if (!filePath) { return; } // user cancelled

		const platform = typeof process !== 'undefined' ? process.platform : 'unknown';
		const ext = extname(filePath);
		const os = detectInstallerOS(ext, platform);
		const { command, hint } = buildInstallerCommand({ os, installerFilePath: filePath });

		if (!command) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.installer.copyCommand.unknown', 'Не удалось определить команду установки для этой платформы. Откройте папку с файлом и запустите вручную.'),
			});
			return;
		}

		await clipboard.writeText(command);
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.installer.copyCommand.copied', 'Команда скопирована в буфер обмена. {0}', hint),
		});
	}
});
