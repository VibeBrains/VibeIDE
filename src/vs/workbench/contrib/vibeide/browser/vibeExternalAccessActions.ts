/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { localize, localize2 } from '../../../../nls.js';
import { IVibeExternalAccessService, ExternalAccessScope } from '../common/vibeExternalAccessService.js';

// O.13 Variant A — pre-authorize / revoke per-folder agent access outside the workspace.

registerAction2(class AllowExternalFolderAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.agent.allowExternalFolder',
			title: localize2('vibeide.agent.allowExternalFolder', 'Разрешить папку для доступа агента'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const access = accessor.get(IVibeExternalAccessService);
		const fileDialog = accessor.get(IFileDialogService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);

		const picked = await fileDialog.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			title: localize('vibeide.agent.allowExternalFolder.pick', 'Выберите папку вне рабочей области для доступа агента'),
		});
		const folder = picked?.[0];
		if (!folder) { return; }

		const scopePick = await quickInput.pick(
			[
				{ label: localize('vibeide.agent.allowExternalFolder.session', 'Только эта сессия'), id: 'session', description: localize('vibeide.agent.allowExternalFolder.sessionDesc', 'до перезагрузки окна') },
				{ label: localize('vibeide.agent.allowExternalFolder.workspace', 'Этот проект (постоянно)'), id: 'workspace', description: localize('vibeide.agent.allowExternalFolder.workspaceDesc', 'сохраняется в настройках workspace') },
			],
			{ placeHolder: localize('vibeide.agent.allowExternalFolder.scope', 'Срок действия разрешения для {0}', folder.fsPath) }
		);
		if (!scopePick) { return; }

		await access.allowFolder(folder, (scopePick as { id: ExternalAccessScope }).id);
		notifications.notify({ severity: Severity.Info, message: localize('vibeide.agent.allowExternalFolder.done', 'Папка разрешена для доступа агента: {0}', folder.fsPath) });
	}
});

registerAction2(class RevokeExternalAccessAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.agent.revokeExternalAccess',
			title: localize2('vibeide.agent.revokeExternalAccess', 'Отозвать разрешение папки для агента'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const access = accessor.get(IVibeExternalAccessService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);

		const entries = access.listAllowed();
		if (entries.length === 0) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.agent.revokeExternalAccess.empty', 'Нет разрешённых внешних папок.') });
			return;
		}
		const pick = await quickInput.pick(
			entries.map(e => ({
				label: e.path,
				description: e.scope === 'session'
					? localize('vibeide.agent.revokeExternalAccess.sessionTag', 'сессия')
					: localize('vibeide.agent.revokeExternalAccess.workspaceTag', 'проект'),
				path: e.path,
			})),
			{ placeHolder: localize('vibeide.agent.revokeExternalAccess.pick', 'Какую папку отозвать?'), canPickMany: false }
		);
		if (!pick) { return; }
		await access.revoke((pick as { path: string }).path);
		notifications.notify({ severity: Severity.Info, message: localize('vibeide.agent.revokeExternalAccess.done', 'Разрешение отозвано: {0}', (pick as { path: string }).path) });
	}
});
