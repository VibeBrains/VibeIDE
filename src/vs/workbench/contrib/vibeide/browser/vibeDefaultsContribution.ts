/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize, localize2 } from '../../../../nls.js';
import { joinPath } from '../../../../base/common/resources.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { applyVibeDefaults } from '../common/vibeDefaults.js';

export const VIBEIDE_APPLY_DEFAULTS_CMD = 'vibeide.defaults.apply';

/**
 * «Установить дефолтную обвязку для агентов (.vibe)» — seeds the workspace `.vibe/` folder with the
 * default agent scaffolding embedded from `.vibe-defaults/`. Same create-if-missing logic the
 * first-open scaffolder uses (VibeConfigInitContribution), exposed on demand so users can top up a
 * project that predates new defaults — without clobbering their own edits.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_APPLY_DEFAULTS_CMD,
			title: localize2('vibeide.defaults.apply', 'Установить дефолтную обвязку для агентов (.vibe)'),
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Capture services synchronously before any await (ServicesAccessor lifetime rule).
		const fileService = accessor.get(IFileService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const notificationService = accessor.get(INotificationService);

		const folders = workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			notificationService.notify({
				severity: Severity.Warning,
				message: localize('vibeide.defaults.apply.noWorkspace', 'Откройте папку проекта — обвязка устанавливается в .vibe рабочей области.'),
			});
			return;
		}

		const vibeDir = joinPath(folders[0].uri, '.vibe');
		try {
			await fileService.createFolder(vibeDir);
			const result = await applyVibeDefaults(fileService, vibeDir);
			notificationService.notify({
				severity: Severity.Info,
				message: localize(
					'vibeide.defaults.apply.done',
					'Дефолтная обвязка для агентов установлена в .vibe: добавлено {0}, без изменений {1}.',
					result.created, result.skipped,
				),
			});
		} catch (e) {
			notificationService.notify({
				severity: Severity.Error,
				message: localize('vibeide.defaults.apply.fail', 'Не удалось установить обвязку в .vibe: {0}', String(e)),
			});
		}
	}
});
