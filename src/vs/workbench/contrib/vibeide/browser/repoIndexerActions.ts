/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IRepoIndexerService } from './repoIndexerService.js';
import { localize, localize2 } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IVibeEmbeddingsService } from '../common/embeddings/embeddingSource.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';

export const REBUILD_REPO_INDEX_ACTION_ID = 'vibeide.rebuildRepoIndex';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: REBUILD_REPO_INDEX_ACTION_ID,
			title: localize2('rebuildRepoIndex', 'Пересобрать индекс репозитория'),
			f1: true,
			category: VIBE_COMMAND_CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const repoIndexerService = accessor.get(IRepoIndexerService);
		await repoIndexerService.rebuildIndex();
	}
});

/** Whether search by meaning works now, and why not when it does not — the answer to «почему ищет только по словам» */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.semanticSearchStatus',
			title: localize2('semanticSearchStatus', 'Поиск по смыслу — состояние'),
			f1: true,
			category: VIBE_COMMAND_CATEGORY,
		});
	}

	run(accessor: ServicesAccessor): void {
		const source = accessor.get(IVibeEmbeddingsService).state;
		const vectors = accessor.get(IRepoIndexerService).vectorStatus();
		const message = !source.ready
			? localize('semanticSearchStatus.off', "Поиск идёт только по словам: {0}.", source.reason ?? '')
			: vectors.total === 0
				? localize('semanticSearchStatus.noIndex', "Источник векторов {0} готов, а индекс проекта ещё не собран: его запускает первый запрос к поиску, векторы посчитаются следом.", source.modelId)
				: vectors.files < vectors.total
					? localize('semanticSearchStatus.building', "Векторы {0}: {1} из {2} файлов{3}. Готовые уже участвуют в поиске.", source.modelId, vectors.files, vectors.total, vectors.building ? localize('semanticSearchStatus.running', ", считаю") : '')
					: localize('semanticSearchStatus.ready', "Поиск по смыслу работает: векторы {0} у всех {1} файлов индекса.", source.modelId, vectors.total);
		accessor.get(INotificationService).notify({ severity: Severity.Info, message });
	}
});
