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
import { localize, localize2 } from '../../../../nls.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';
import { IndexResultParts, parseIndexResult } from '../common/indexResult.js';

const RESULT_COUNT = 20;
const MIN_QUERY_LENGTH = 2;
const QUERY_DEBOUNCE_MS = 300;


type IndexResultPick = IQuickPickItem & { readonly result?: IndexResultParts };

/**
 * Asks the repo index in plain words and opens the chosen fragment with its lines selected
 *
 * Takes an optional query: `vibeide.search.semantic` hands its argument here, so search has one picker
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibe.codebase.query',
			f1: true,
			title: localize2('vibeCodebaseQuery', 'Спросить по кодовой базе'),
			category: VIBE_COMMAND_CATEGORY,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyQ,
				weight: KeybindingWeight.ExternalExtension,
				when: ContextKeyExpr.deserialize('!terminalFocus'),
			},
		});
	}

	async run(accessor: ServicesAccessor, initialQuery?: string): Promise<void> {
		const repoIndexerService = accessor.get(IRepoIndexerService);
		const quickInputService = accessor.get(IQuickInputService);
		const editorService = accessor.get(IEditorService);
		const labelService = accessor.get(ILabelService);

		const disposables = new DisposableStore();
		const quickPick = disposables.add(quickInputService.createQuickPick<IndexResultPick>());
		quickPick.placeholder = localize('vibeCodebaseQueryPlaceholder', "Опишите словами, что ищете в коде");
		quickPick.title = localize('vibeCodebaseQueryTitle', "Спросить по кодовой базе");
		// The index ranks by meaning, so the picker must not filter its answers again by the typed words
		quickPick.filterValue = () => '';

		const queryScheduler = disposables.add(new RunOnceScheduler(async () => {
			const query = quickPick.value.trim();
			if (query.length < MIN_QUERY_LENGTH) {
				quickPick.items = [];
				quickPick.busy = false;
				return;
			}
			quickPick.busy = true;
			try {
				const answers = await repoIndexerService.query(query, RESULT_COUNT);
				if (query !== quickPick.value.trim()) {
					return;
				}
				const items: IndexResultPick[] = [];
				for (const answer of answers) {
					const result = parseIndexResult(answer);
					if (!result) {
						continue;
					}
					const uri = URI.file(result.path);
					items.push({
						label: `$(file) ${labelService.getUriLabel(uri, { relative: true })}`,
						description: result.startLine === result.endLine
							? localize('vibeCodebaseQueryLine', "строка {0}", result.startLine)
							: localize('vibeCodebaseQueryLines', "строки {0}–{1}", result.startLine, result.endLine),
						detail: firstMeaningfulLine(result.preview),
						result,
						alwaysShow: true,
					});
				}
				// The first question starts the index build; an empty answer then means «not yet», not «nothing»
				const indexing = items.length === 0 && repoIndexerService.vectorStatus().total === 0;
				quickPick.items = items.length > 0 ? items : [indexing ? {
					label: localize('vibeCodebaseQueryIndexing', "Индекс проекта ещё собирается"),
					description: localize('vibeCodebaseQueryIndexingDesc', "Спросите снова через минуту"),
				} : {
					label: localize('vibeCodebaseQueryNoResults', "Ничего не найдено"),
					description: localize('vibeCodebaseQueryNoResultsDesc', "Попробуйте сказать иначе"),
				}];
			} catch (error) {
				quickPick.items = [{
					label: localize('vibeCodebaseQueryError', "Не удалось спросить индекс проекта"),
					description: error instanceof Error ? error.message : String(error),
				}];
			} finally {
				quickPick.busy = false;
			}
		}, QUERY_DEBOUNCE_MS));

		disposables.add(quickPick.onDidChangeValue(() => queryScheduler.schedule()));
		disposables.add(quickPick.onDidAccept(() => {
			const result = quickPick.selectedItems[0]?.result;
			if (!result) {
				return;
			}
			quickPick.hide();
			editorService.openEditor({
				resource: URI.file(result.path),
				options: {
					pinned: false,
					revealIfOpened: true,
					selection: { startLineNumber: result.startLine, startColumn: 1, endLineNumber: result.endLine, endColumn: 1 },
				},
			});
		}));
		disposables.add(quickPick.onDidHide(() => disposables.dispose()));

		quickPick.show();
		if (initialQuery?.trim()) {
			quickPick.value = initialQuery.trim();
			queryScheduler.schedule(0);
		}
	}
});

/** The first line of a fragment that says something, as a hint of what the answer holds: rules like `/*----` say nothing */
function firstMeaningfulLine(preview: string): string | undefined {
	return preview.split('\n').map(line => line.trim()).find(line => /[\p{L}\p{N}]/u.test(line));
}
