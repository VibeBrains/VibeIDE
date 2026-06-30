/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IRepoIndexerService } from './repoIndexerService.js';
import { localize2 } from '../../../../nls.js';

export const REBUILD_REPO_INDEX_ACTION_ID = 'vibeide.rebuildRepoIndex';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: REBUILD_REPO_INDEX_ACTION_ID,
			title: localize2('rebuildRepoIndex', 'VibeIDE: Rebuild Repo Index'),
			f1: true,
			category: localize2('vibeide', 'VibeIDE'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const repoIndexerService = accessor.get(IRepoIndexerService);
		await repoIndexerService.rebuildIndex();
	}
});

