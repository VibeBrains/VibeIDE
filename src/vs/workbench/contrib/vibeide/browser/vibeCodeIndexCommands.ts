/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';
import { CONFIG_EXCLUDED_FOLDERS, IVibeCodeIndexService } from './vibeCodeIndexService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/**
 * Two commands that answer «почему переход не сработал» without guessing.
 *
 * WHY they exist: when a jump finds nothing, every explanation is equally plausible from the
 * outside — the index is still building, the language is switched off, the declaration lives in an
 * excluded folder, or there is genuinely no such declaration. The status command replaces that guess
 * with numbers, and the rebuild command covers the one case the numbers cannot fix by themselves.
 */

class VibeCodeIndexStatusAction extends Action2 {

	static readonly ID = 'vibeide.codeNavigation.showIndexStatus';

	constructor() {
		super({
			id: VibeCodeIndexStatusAction.ID,
			title: localize2('vibeide.codeNavigation.showIndexStatus', 'Состояние индекса навигации'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const indexService = accessor.get(IVibeCodeIndexService);
		const dialogService = accessor.get(IDialogService);
		const workspace = accessor.get(IWorkspaceContextService);
		const configuration = accessor.get(IConfigurationService);

		const folders = workspace.getWorkspace().folders;
		const lines: string[] = [];

		if (folders.length === 0) {
			// Nothing is indexed outside a folder, and that alone explains an empty result.
			lines.push(localize('vibeide.codeNavigation.noFolder', 'Папка не открыта — индексировать нечего. Переход работает только внутри открытой папки или рабочей области.'), '');
		}

		for (const status of indexService.status()) {
			if (!status.enabled) {
				lines.push(localize('vibeide.codeNavigation.statusOff', '{0} — выключен в настройках', status.languageId));
			} else if (status.building) {
				lines.push(localize('vibeide.codeNavigation.statusBuilding', '{0} — строится сейчас', status.languageId));
			} else if (!status.built) {
				lines.push(localize('vibeide.codeNavigation.statusIdle', '{0} — ещё не строился (соберётся, когда откроете файл этого языка)', status.languageId));
			} else if (status.truncated) {
				lines.push(localize('vibeide.codeNavigation.statusTruncated', '{0} — {1} имён из {2} файлов, НЕПОЛНЫЙ: обход остановился на пределе файлов. Поднимите «vibeide.codeNavigation.maxIndexedFiles».', status.languageId, status.names, status.files));
			} else {
				lines.push(localize('vibeide.codeNavigation.statusBuilt', '{0} — {1} имён из {2} файлов', status.languageId, status.names, status.files));
			}
		}

		const excluded = configuration.getValue<unknown>(CONFIG_EXCLUDED_FOLDERS);
		if (Array.isArray(excluded) && excluded.length > 0) {
			lines.push('', localize('vibeide.codeNavigation.statusExcluded', 'Не индексируются папки: {0}. Плюс то, что скрыто вашими files.exclude и search.exclude.', excluded.join(', ')));
		}
		lines.push('', localize('vibeide.codeNavigation.statusHint', 'Если объявление лежит в одной из этих папок (например в vendor), переход его не найдёт — уберите папку из списка «vibeide.codeNavigation.excludedFolders».'));

		await dialogService.info(localize('vibeide.codeNavigation.statusTitle', 'Индекс навигации по коду'), lines.join('\n'));
	}
}

class VibeCodeIndexRebuildAction extends Action2 {

	static readonly ID = 'vibeide.codeNavigation.rebuildIndex';

	constructor() {
		super({
			id: VibeCodeIndexRebuildAction.ID,
			title: localize2('vibeide.codeNavigation.rebuildIndex', 'Перестроить индекс навигации'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IVibeCodeIndexService).rebuild();
		// The rebuild itself happens on the next request, with its own progress in the status bar;
		// promising «готово» here would be a lie about work that has not started.
		accessor.get(INotificationService).info(localize('vibeide.codeNavigation.rebuildDone', 'Индекс сброшен — соберётся заново при следующем переходе или открытии файла.'));
	}
}

registerAction2(VibeCodeIndexStatusAction);
registerAction2(VibeCodeIndexRebuildAction);
