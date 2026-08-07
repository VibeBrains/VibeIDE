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
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IVibeExternalAccessService, ExternalAccessScope, READ_ONLY_FOLDERS_KEY, normalizeFolderPath } from '../common/vibeExternalAccessService.js';
import { isWindows } from '../../../../base/common/platform.js';

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

/**
 * Reference folders — the read-only twin of the action above.
 *
 * Kept as a separate command rather than a third "scope" of the allow dialog: the scopes answer
 * "for how long", this answers "with what rights", and folding them into one list would let a
 * mis-click hand write access to a knowledge base.
 */
registerAction2(class AddReferenceFolderAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.agent.addReferenceFolder',
			title: localize2('vibeide.agent.addReferenceFolder', 'Добавить папку-справочник для агента (только чтение)'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialog = accessor.get(IFileDialogService);
		const config = accessor.get(IConfigurationService);
		const notifications = accessor.get(INotificationService);

		const picked = await fileDialog.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			title: localize('vibeide.agent.addReferenceFolder.pick', 'Выберите папку-справочник: агент сможет её читать, но не изменять'),
		});
		const folder = picked?.[0];
		if (!folder) { return; }

		const current = config.getValue<string[]>(READ_ONLY_FOLDERS_KEY) ?? [];
		const caseSensitive = !isWindows;
		const already = current.some(p => normalizeFolderPath(p, caseSensitive) === normalizeFolderPath(folder.fsPath, caseSensitive));
		if (already) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.agent.addReferenceFolder.already', 'Эта папка уже подключена как справочник: {0}', folder.fsPath) });
			return;
		}

		await config.updateValue(READ_ONLY_FOLDERS_KEY, [...current, folder.fsPath], ConfigurationTarget.WORKSPACE);
		notifications.notify({ severity: Severity.Info, message: localize('vibeide.agent.addReferenceFolder.done', 'Папка-справочник подключена: {0}. Агент читает её, но не изменяет.', folder.fsPath) });
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
		const config = accessor.get(IConfigurationService);

		// Reference folders are listed here too: they are external access the user granted, and a
		// revoke command that cannot see half of what it granted teaches people not to trust it.
		const references = config.getValue<string[]>(READ_ONLY_FOLDERS_KEY) ?? [];
		const entries = [
			...access.listAllowed().map(e => ({
				label: e.path,
				description: e.scope === 'session'
					? localize('vibeide.agent.revokeExternalAccess.sessionTag', 'сессия')
					: localize('vibeide.agent.revokeExternalAccess.workspaceTag', 'проект'),
				path: e.path,
				reference: false,
			})),
			...references.map(path => ({
				label: path,
				description: localize('vibeide.agent.revokeExternalAccess.referenceTag', 'справочник, только чтение'),
				path,
				reference: true,
			})),
		];
		if (entries.length === 0) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.agent.revokeExternalAccess.empty', 'Нет разрешённых внешних папок.') });
			return;
		}
		const pick = await quickInput.pick(
			entries,
			{ placeHolder: localize('vibeide.agent.revokeExternalAccess.pick', 'Какую папку отозвать?'), canPickMany: false }
		);
		if (!pick) { return; }
		const chosen = pick as { path: string; reference: boolean };
		if (chosen.reference) {
			const caseSensitive = !isWindows;
			const left = references.filter(p => normalizeFolderPath(p, caseSensitive) !== normalizeFolderPath(chosen.path, caseSensitive));
			await config.updateValue(READ_ONLY_FOLDERS_KEY, left, ConfigurationTarget.WORKSPACE);
		} else {
			await access.revoke(chosen.path);
		}
		notifications.notify({ severity: Severity.Info, message: localize('vibeide.agent.revokeExternalAccess.done', 'Разрешение отозвано: {0}', chosen.path) });
	}
});
