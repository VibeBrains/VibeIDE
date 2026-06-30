/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IRepoIndexerService } from './repoIndexerService.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';

/**
 * Command to query the codebase using natural language
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibe.codebase.query',
			f1: true,
			title: localize2('vibeCodebaseQuery', 'VibeIDE: Query Codebase'),
			category: localize2('vibeCategory', 'VibeIDE'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyQ,
				weight: KeybindingWeight.ExternalExtension,
				when: ContextKeyExpr.deserialize('!terminalFocus'),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const repoIndexerService = accessor.get(IRepoIndexerService);
		const quickInputService = accessor.get(IQuickInputService);
		const editorService = accessor.get(IEditorService);
		const labelService = accessor.get(ILabelService);

		// Create quick pick
		const quickPick = quickInputService.createQuickPick<IQuickPickItem & { uri?: URI }>();
		quickPick.placeholder = localize2('vibeCodebaseQueryPlaceholder', 'Enter a natural language query to search your codebase...').value;
		quickPick.title = localize2('vibeCodebaseQueryTitle', 'Query Codebase').value;

		const disposables = new DisposableStore();
		disposables.add(quickPick);

		// Debounce query execution
		const queryScheduler = new RunOnceScheduler(async () => {
			const query = quickPick.value.trim();
			if (!query || query.length < 2) {
				quickPick.items = [];
				quickPick.busy = false;
				return;
			}

			quickPick.busy = true;

			try {
				// Query the repo indexer (returns top 20 results)
				const results = await repoIndexerService.query(query, 20);

				// Convert to quick pick items
				const items: Array<IQuickPickItem & { uri?: URI }> = results.map((filePath) => {
					const uri = URI.file(filePath);
					const relativePath = labelService.getUriLabel(uri, { relative: true });
					const fullPath = labelService.getUriLabel(uri, { relative: false });

					return {
						label: `$(file) ${relativePath}`,
						description: fullPath,
						uri,
						alwaysShow: true,
					};
				});

				if (items.length === 0) {
					items.push({
						label: localize2('vibeCodebaseQueryNoResults', 'No results found').value,
						description: localize2('vibeCodebaseQueryNoResultsDesc', 'Try a different query').value,
					});
				}

				quickPick.items = items;
			} catch (error) {
				quickPick.items = [{
					label: localize2('vibeCodebaseQueryError', 'Error querying codebase').value,
					description: error instanceof Error ? error.message : String(error),
				}];
			} finally {
				quickPick.busy = false;
			}
		}, 300); // 300ms debounce

		disposables.add(queryScheduler);

		// Trigger query on input change
		disposables.add(quickPick.onDidChangeValue(() => {
			queryScheduler.schedule();
		}));

		// Handle item selection
		disposables.add(quickPick.onDidAccept(() => {
			const selectedItem = quickPick.selectedItems[0];
			if (selectedItem?.uri) {
				// Open the file
				editorService.openEditor({
					resource: selectedItem.uri,
					options: { pinned: false, revealIfOpened: true },
				});
				quickPick.hide();
			}
		}));

		// Show the quick pick
		quickPick.show();

		// Cleanup on dispose
		disposables.add(quickPick.onDidHide(() => {
			disposables.dispose();
		}));
	}
});

