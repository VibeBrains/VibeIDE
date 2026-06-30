/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize, localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';


import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';

import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';

import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { VIBEIDE_VIEW_CONTAINER_ID, VIBEIDE_CHAT_VIEW_ID } from './sidebarPane.js';
import { IMetricsService } from '../common/metricsService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { VIBEIDE_TOGGLE_SETTINGS_ACTION_ID } from './vibeideSettingsPane.js';
import { VIBEIDE_CTRL_L_ACTION_ID } from './actionIDs.js';
import { IChatThreadService } from './chatThreadService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { openVibeChatEditor } from './vibeideChatPane.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

// ---------- Register commands and keybindings ----------


export const roundRangeToLines = (range: IRange | null | undefined, options: { emptySelectionBehavior: 'null' | 'line' }) => {
	if (!range) { return null; }

	// treat as no selection if selection is empty
	if (range.endColumn === range.startColumn && range.endLineNumber === range.startLineNumber) {
		if (options.emptySelectionBehavior === 'null') { return null; }
		else if (options.emptySelectionBehavior === 'line') { return { startLineNumber: range.startLineNumber, startColumn: 1, endLineNumber: range.startLineNumber, endColumn: 1 }; }
	}

	// IRange is 1-indexed
	const endLine = range.endColumn === 1 ? range.endLineNumber - 1 : range.endLineNumber; // e.g. if the user triple clicks, it selects column=0, line=line -> column=0, line=line+1
	const newRange: IRange = {
		startLineNumber: range.startLineNumber,
		startColumn: 1,
		endLineNumber: endLine,
		endColumn: Number.MAX_SAFE_INTEGER
	};
	return newRange;
};

// const getContentInRange = (model: ITextModel, range: IRange | null) => {
// 	if (!range)
// 		return null
// 	const content = model.getValueInRange(range)
// 	const trimmedContent = content
// 		.replace(/^\s*\n/g, '') // trim pure whitespace lines from start
// 		.replace(/\n\s*$/g, '') // trim pure whitespace lines from end
// 	return trimmedContent
// }



const VIBEIDE_OPEN_SIDEBAR_ACTION_ID = 'vibeide.sidebar.open';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_OPEN_SIDEBAR_ACTION_ID,
			title: localize2('vibeOpenSidebar', 'VibeIDE: Открыть чат'),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.ExternalExtension,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		const chatThreadsService = accessor.get(IChatThreadService);
		await openVibeChatEditor(instantiationService);
		await chatThreadsService.focusCurrentChat();
	}
});

// Free built-in MS Chat open chord for VibeIDE: New Chat (vibeide.cmdShiftL) uses Ctrl+Alt+I.
KeybindingsRegistry.registerKeybindingRule({
	id: '-workbench.action.chat.open',
	weight: KeybindingWeight.ExternalExtension,
	primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
	mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyI },
});


// cmd L
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_CTRL_L_ACTION_ID,
			f1: true,
			title: localize2('vibeCmdL', 'VibeIDE: Добавить выделение в чат'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyL,
				weight: KeybindingWeight.ExternalExtension
			}
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		// Get services
		const metricsService = accessor.get(IMetricsService);
		const editorService = accessor.get(ICodeEditorService);
		const chatThreadService = accessor.get(IChatThreadService);

		metricsService.capture('Ctrl+L', {});

		// capture selection and model before opening the chat panel
		const editor = editorService.getActiveCodeEditor();
		const model = editor?.getModel();

		// open chat editor - always open even if no editor
		await openVibeChatEditor(accessor.get(IInstantiationService));

		// If there's a model, add selection to chat
		if (model) {
			const selectionRange = roundRangeToLines(editor?.getSelection(), { emptySelectionBehavior: 'null' });

			// add line selection
			if (selectionRange) {
				editor?.setSelection({
					startLineNumber: selectionRange.startLineNumber,
					endLineNumber: selectionRange.endLineNumber,
					startColumn: 1,
					endColumn: Number.MAX_SAFE_INTEGER
				});
				chatThreadService.addNewStagingSelection({
					type: 'CodeSelection',
					uri: model.uri,
					language: model.getLanguageId(),
					range: [selectionRange.startLineNumber, selectionRange.endLineNumber],
					state: { wasAddedAsCurrentFile: false },
				});
			}
			// add file
			else {
				chatThreadService.addNewStagingSelection({
					type: 'File',
					uri: model.uri,
					language: model.getLanguageId(),
					state: { wasAddedAsCurrentFile: false },
				});
			}
		}

		await chatThreadService.focusCurrentChat();
	}
});


// New chat keybind + menu button
const VIBEIDE_CMD_SHIFT_L_ACTION_ID = 'vibeide.cmdShiftL';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_CMD_SHIFT_L_ACTION_ID,
			title: localize2('vibeNewChatPalette', 'VibeIDE: Новый чат'),
			keybinding: {
				weight: KeybindingWeight.ExternalExtension,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyI },
			},
			icon: { id: 'add' },
			menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 1, when: ContextKeyExpr.equals('view', VIBEIDE_CHAT_VIEW_ID) }],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {

		const metricsService = accessor.get(IMetricsService);
		const chatThreadsService = accessor.get(IChatThreadService);
		const editorService = accessor.get(ICodeEditorService);
		// Capture instantiationService synchronously — the accessor is only valid until the first await below; we still need to launch services after the await.
		const instantiationService = accessor.get(IInstantiationService);

		// Capture current chat state BEFORE creating new tab — opening a new tab swaps the global currentThreadId.
		// IMPORTANT: ChatThreadService's constructor calls openNewThread() which sets mountedInfo.whenMounted to a pending Promise. On a cold start (no chat tab opened yet) that Promise NEVER resolves — `await` here would hang forever and the new chat tab would never get created. Gate on mountedIsResolvedRef.current so we only await when React has actually mounted the UI.
		const oldThreadId = chatThreadsService.state.currentThreadId;
		const oldThread = oldThreadId ? chatThreadsService.state.allThreads[oldThreadId] : undefined;
		const oldMount = oldThread?.state.mountedInfo;
		const oldUI = oldMount?.mountedIsResolvedRef.current ? await oldMount.whenMounted : undefined;
		const oldSelns = oldThread?.state.stagingSelections;
		const oldVal = oldUI?.textAreaRef?.current?.value;

		// Open a brand-new chat tab (subject to vibeide.chat.maxOpenTabs).
		// openVibeChatEditor calls openNewThread() internally and routes the focus to the new tab.
		await openVibeChatEditor(instantiationService, { newChat: true });
		await chatThreadsService.focusCurrentChat();
		metricsService.capture('Chat Navigation', { type: 'Start New Chat' });

		// Carry over staging selections and textarea value to the new tab so the user keeps their flow.
		const newThreadId = chatThreadsService.state.currentThreadId;
		const newThread = newThreadId ? chatThreadsService.state.allThreads[newThreadId] : undefined;
		const newMount = newThread?.state.mountedInfo;
		const newUI = newMount?.mountedIsResolvedRef.current ? await newMount.whenMounted : undefined;
		if (newThreadId && newThreadId !== oldThreadId) {
			chatThreadsService.setCurrentThreadState({ stagingSelections: oldSelns, });
			if (newUI?.textAreaRef?.current && oldVal) { newUI.textAreaRef.current.value = oldVal; }
		}


		// if has selection, add it
		const editor = editorService.getActiveCodeEditor();
		const model = editor?.getModel();
		if (!model) { return; }
		const selectionRange = roundRangeToLines(editor?.getSelection(), { emptySelectionBehavior: 'null' });
		if (!selectionRange) { return; }
		editor?.setSelection({ startLineNumber: selectionRange.startLineNumber, endLineNumber: selectionRange.endLineNumber, startColumn: 1, endColumn: Number.MAX_SAFE_INTEGER });
		chatThreadsService.addNewStagingSelection({
			type: 'CodeSelection',
			uri: model.uri,
			language: model.getLanguageId(),
			range: [selectionRange.startLineNumber, selectionRange.endLineNumber],
			state: { wasAddedAsCurrentFile: false },
		});
	}
});

// History command — opens the AuxiliaryBar history panel (no toolbar button: the panel IS history)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibe.historyAction',
			title: localize('vibeide.history.openPanel', 'История чатов'),
			icon: { id: 'history' },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const metricsService = accessor.get(IMetricsService);
		const viewsService = accessor.get(IViewsService);

		metricsService.capture('Chat Navigation', { type: 'History' });
		viewsService.openViewContainer(VIBEIDE_VIEW_CONTAINER_ID);
	}
});


// Settings gear
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibe.settingsAction',
			title: localize2('vibeSettingsSidebar', 'Настройки VibeIDE'),
			icon: { id: 'settings-gear' },
			menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 3, when: ContextKeyExpr.equals('view', VIBEIDE_CHAT_VIEW_ID), }]
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		commandService.executeCommand(VIBEIDE_TOGGLE_SETTINGS_ACTION_ID);
	}
});

// Web Search command
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibe.webSearch',
			title: localize2('vibeWebSearch', 'VibeIDE: Поиск в интернете'),
			category: localize2('vibeCategory', 'VibeIDE'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const chatThreadsService = accessor.get(IChatThreadService);
		const viewsService = accessor.get(IViewsService);
		const quickInputService = accessor.get(IQuickInputService);

		// Open chat sidebar
		viewsService.openViewContainer(VIBEIDE_VIEW_CONTAINER_ID);
		await chatThreadsService.focusCurrentChat();

		// Prompt for search query
		const query = await quickInputService.input({
			placeHolder: localize2('vibeWebSearchPlaceholder', 'Введите поисковый запрос...').value,
			prompt: localize2('vibeWebSearchPrompt', 'Поиск информации в интернете').value,
		}).then((result: string | undefined) => result);

		if (!query) { return; }

		const threadId = chatThreadsService.state.currentThreadId;
		await chatThreadsService.addUserMessageAndStreamResponse({
			userMessage: `Search the web for: ${query}`,
			threadId,
		});
	}
});

// Browse URL command
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibe.browseUrl',
			title: localize2('vibeBrowseUrl', 'VibeIDE: Открыть URL в ридере'),
			category: localize2('vibeCategory', 'VibeIDE'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const chatThreadsService = accessor.get(IChatThreadService);
		const viewsService = accessor.get(IViewsService);
		const quickInputService = accessor.get(IQuickInputService);

		// Open chat sidebar
		viewsService.openViewContainer(VIBEIDE_VIEW_CONTAINER_ID);
		await chatThreadsService.focusCurrentChat();

		// Prompt for URL
		const url = await quickInputService.input({
			placeHolder: localize2('vibeBrowseUrlPlaceholder', 'Введите URL (https://...)').value,
			prompt: localize2('vibeBrowseUrlPrompt', 'Загрузить и извлечь содержимое URL').value,
		}).then((result: string | undefined) => result);

		if (!url) { return; }

		const threadId = chatThreadsService.state.currentThreadId;
		await chatThreadsService.addUserMessageAndStreamResponse({
			userMessage: `Browse URL: ${url}`,
			threadId,
		});
	}
});




// export class TabSwitchListener extends Disposable {

// 	constructor(
// 		onSwitchTab: () => void,
// 		@ICodeEditorService private readonly _editorService: ICodeEditorService,
// 	) {
// 		super()

// 		// when editor switches tabs (models)
// 		const addTabSwitchListeners = (editor: ICodeEditor) => {
// 			this._register(editor.onDidChangeModel(e => {
// 				if (e.newModelUrl?.scheme !== 'file') return
// 				onSwitchTab()
// 			}))
// 		}

// 		const initializeEditor = (editor: ICodeEditor) => {
// 			addTabSwitchListeners(editor)
// 		}

// 		// initialize current editors + any new editors
// 		for (let editor of this._editorService.listCodeEditors()) initializeEditor(editor)
// 		this._register(this._editorService.onCodeEditorAdd(editor => { initializeEditor(editor) }))
// 	}
// }
