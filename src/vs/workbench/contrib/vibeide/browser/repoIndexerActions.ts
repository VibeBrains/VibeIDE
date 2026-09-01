/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IRepoIndexerService } from './repoIndexerService.js';
import { localize2 } from '../../../../nls.js';
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

