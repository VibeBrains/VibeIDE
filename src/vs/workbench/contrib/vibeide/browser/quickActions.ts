/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IChatThreadService } from './chatThreadService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
// removed unused IQuickInputService import
import { localize2, ILocalizedString } from '../../../../nls.js';
import { VIBEIDE_VIEW_CONTAINER_ID } from './sidebarPane.js';
import { roundRangeToLines } from './sidebarActions.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

type QuickActionTask = 'explainCode' | 'refactorCode' | 'addTests' | 'fixTests' | 'writeDocstring' | 'optimizeCode' | 'debugCode';

const makeUserPayload = ({ task, path, language, startLine, endLine, extra }: { task: QuickActionTask; path: string; language: string; startLine: number; endLine: number; extra?: Record<string, unknown> }) => {
	const instruction = typeof extra?.instruction === 'string' ? `\n\nInstruction: ${extra?.instruction}` : '';
	const replyFormat = `\n\nReply format: Do NOT output any XML/HTML-like tags or tool-call wrappers (no <edit_file>, no <search_replace_blocks>, no JSON payloads). If returning code, output only a concise fenced code block. Otherwise reply in plain language.`;
	return `Task: ${task}\nFile: ${path}\nLanguage: ${language}\nSelection: ${startLine}-${endLine}${instruction}${replyFormat}\n\nUse the attached selection and nearby context.`;
};

async function openChatIfNeeded(viewsService: IViewsService) {
	viewsService.openViewContainer(VIBEIDE_VIEW_CONTAINER_ID);
}

async function gatherSelectionContext(services: { editorService: ICodeEditorService; workspace: IWorkspaceContextService }): Promise<{
	ok: boolean;
	error?: string;
	taskContext?: { code: string; path: string; language: string; nearby: string; startLine: number; endLine: number };
}> {
	const editorService = services.editorService;
	const workspace = services.workspace;

	const editor = editorService.getActiveCodeEditor();
	if (!editor) { return { ok: false, error: 'Please open a file.' }; }
	const model = editor.getModel();
	if (!model) { return { ok: false, error: 'No file is open.' }; }

	if (!workspace.isInsideWorkspace(model.uri)) {
		return { ok: false, error: 'Quick Actions only work on files within the workspace.' };
	}

	const selection = roundRangeToLines(editor.getSelection(), { emptySelectionBehavior: 'null' });
	if (!selection) {
		return { ok: false, error: 'Select some code to use Quick Actions.' };
	}

	const { startLineNumber, endLineNumber } = selection;
	const code = model.getValueInRange(selection, EndOfLinePreference.LF);
	if (!code.trim()) {
		return { ok: false, error: 'Selection is empty.' };
	}

	// Basic unsupported language handling for non-code selections
	const languageId = model.getLanguageId();
	if (languageId === 'markdown' || languageId === 'plaintext') {
		return { ok: false, error: 'Quick Actions are intended for source code files. Please select code.' };
	}

	// nearby context
	const ctxLines = 6;
	const ctxStart = Math.max(1, startLineNumber - ctxLines);
	const ctxEnd = Math.min(model.getLineCount(), endLineNumber + ctxLines);
	const nearby = model.getValueInRange(
		{ startLineNumber: ctxStart, startColumn: 1, endLineNumber: ctxEnd, endColumn: Number.MAX_SAFE_INTEGER },
		EndOfLinePreference.LF
	);

	return {
		ok: true,
		taskContext: {
			code,
			path: model.uri.fsPath,
			language: model.getLanguageId(),
			nearby,
			startLine: startLineNumber,
			endLine: endLineNumber,
		}
	};
}

async function addSelectionChip(services: { editorService: ICodeEditorService; chatThreadsService: IChatThreadService }) {
	const editorService = services.editorService;
	const chatThreadsService = services.chatThreadsService;
	const editor = editorService.getActiveCodeEditor();
	const model = editor?.getModel();
	if (!editor || !model) { return; }
	const selectionRange = roundRangeToLines(editor.getSelection(), { emptySelectionBehavior: 'null' });
	if (!selectionRange) { return; }
	editor.setSelection({ startLineNumber: selectionRange.startLineNumber, endLineNumber: selectionRange.endLineNumber, startColumn: 1, endColumn: Number.MAX_SAFE_INTEGER });
	chatThreadsService.addNewStagingSelection({
		type: 'CodeSelection',
		uri: model.uri,
		language: model.getLanguageId(),
		range: [selectionRange.startLineNumber, selectionRange.endLineNumber],
		state: { wasAddedAsCurrentFile: false },
	});
}

function registerQuickAction({ id, title, kb, task, promptMaker }: {
	id: string;
	title: ILocalizedString;
	kb?: number;
	task: QuickActionTask;
	promptMaker?: (base: { path: string; language: string; code: string; nearby: string; startLine: number; endLine: number }) => string;
}) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id,
				f1: true,
				title,
				keybinding: kb ? {
					primary: kb,
					when: ContextKeyExpr.deserialize('editorFocus && !terminalFocus'),
					weight: KeybindingWeight.ExternalExtension,
				} : undefined,
				menu: {
					id: MenuId.EditorContext,
					group: 'navigation',
					order: 10,
					when: ContextKeyExpr.deserialize('editorTextFocus && !terminalFocus'),
				}
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const notificationService = accessor.get(INotificationService);
			const chatThreadsService = accessor.get(IChatThreadService);
			const statusbarService = accessor.get(IStatusbarService);
			const viewsService = accessor.get(IViewsService);
			const editorService = accessor.get(ICodeEditorService);
			const workspace = accessor.get(IWorkspaceContextService);

			const ctx = await gatherSelectionContext({ editorService, workspace });
			if (!ctx.ok || !ctx.taskContext) {
				if (ctx.error) { notificationService.warn(ctx.error); }
				return;
			}

			await openChatIfNeeded(viewsService);
			await addSelectionChip({ editorService, chatThreadsService });

			const { path, language, code, nearby, startLine, endLine } = ctx.taskContext;

			// Build structured payload; allow specific overrides per action
			let userMessage: string;
			if (promptMaker) {
				userMessage = promptMaker({ path, language, code, nearby, startLine, endLine });
			} else {
				userMessage = makeUserPayload({ task, path, language, startLine, endLine });
			}

			// Prepend a human-readable mode label for the chat UI
			const taskToLabel: Record<QuickActionTask, string> = {
				explainCode: 'Explain',
				refactorCode: 'Refactor',
				addTests: 'Add Tests',
				fixTests: 'Fix Tests',
				writeDocstring: 'Write Docstring',
				optimizeCode: 'Optimize',
				debugCode: 'Debug',
			};
			const label = taskToLabel[task];
			userMessage = `**${label}**\n\n` + userMessage;

			// Show transient status bar progress during execution
			const verbByTask: Record<QuickActionTask, string> = {
				explainCode: 'Explaining code…',
				refactorCode: 'Refactoring…',
				addTests: 'Generating tests…',
				fixTests: 'Fixing tests…',
				writeDocstring: 'Writing docstring…',
				optimizeCode: 'Analyzing performance…',
				debugCode: 'Debugging…',
			};
			const text = `$(sync~spin) ${verbByTask[task]}`;
			const entry = statusbarService.addEntry({ name: 'VibeIDE', text, ariaLabel: verbByTask[task], tooltip: title }, `vibe.quickAction.${task}`, StatusbarAlignment.LEFT);

			try {
				const threadId = chatThreadsService.state.currentThreadId;
				// Ensure Quick Actions do not trigger agent/plan mode and show concise display in chat
				const displayContent = `${label} ${path.split('/').pop()}:${startLine}-${endLine}`;
				await chatThreadsService.addUserMessageAndStreamResponse({ userMessage, threadId, noPlan: true, displayContent });
			} finally {
				entry.dispose();
			}
		}
	});
}

// Explain Code
registerQuickAction({
	id: 'vibe.explainCode',
	title: localize2('vibeExplainCode', 'VibeIDE: Explain Code'),
	kb: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyX,
	task: 'explainCode',
	promptMaker: ({ path, language, startLine, endLine }) => makeUserPayload({
		task: 'explainCode', path, language, startLine, endLine, extra: { instruction: 'Explain the selected code clearly, step-by-step, referencing important lines.' }
	})
});

// Refactor Code
registerQuickAction({
	id: 'vibe.refactorCode',
	title: localize2('vibeRefactorCode', 'VibeIDE: Refactor Code'),
	kb: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR,
	task: 'refactorCode',
	promptMaker: ({ path, language, startLine, endLine }) => makeUserPayload({
		task: 'refactorCode', path, language, startLine, endLine, extra: { instruction: 'Refactor to be clearer and idiomatic. Preserve behavior. Return the improved snippet only.' }
	})
});

// Add Tests
registerQuickAction({
	id: 'vibe.addTests',
	title: localize2('vibeAddTests', 'VibeIDE: Add Tests'),
	kb: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyT,
	task: 'addTests',
	promptMaker: ({ path, language, startLine, endLine }) => makeUserPayload({
		task: 'addTests', path, language, startLine, endLine, extra: { instruction: 'Generate unit tests for the selection using the common framework for this language.' }
	})
});

// Fix Tests
registerQuickAction({
	id: 'vibe.fixTests',
	title: localize2('vibeFixTests', 'VibeIDE: Fix Failing Tests'),
	kb: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF,
	task: 'fixTests',
	promptMaker: ({ path, language, startLine, endLine }) => makeUserPayload({
		task: 'fixTests', path, language, startLine, endLine, extra: { instruction: 'Diagnose failing tests in context and suggest minimal fixes with reasons.' }
	})
});

// Write Docstring
registerQuickAction({
	id: 'vibe.writeDocstring',
	title: localize2('vibeWriteDocstring', 'VibeIDE: Write Docstring'),
	kb: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD,
	task: 'writeDocstring',
	promptMaker: ({ path, language, startLine, endLine }) => makeUserPayload({
		task: 'writeDocstring', path, language, startLine, endLine, extra: { instruction: 'Write a style-appropriate docstring for the selected function/class.' }
	})
});

// Optimize Code
registerQuickAction({
	id: 'vibe.optimizeCode',
	title: localize2('vibeOptimizeCode', 'VibeIDE: Optimize Code'),
	kb: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO,
	task: 'optimizeCode',
	promptMaker: ({ path, language, startLine, endLine }) => makeUserPayload({
		task: 'optimizeCode', path, language, startLine, endLine, extra: { instruction: 'Suggest performance improvements (time/memory). Provide improved snippet or diffs.' }
	})
});

// Debug Code
registerQuickAction({
	id: 'vibe.debugCode',
	title: localize2('vibeDebugCode', 'VibeIDE: Debug Code'),
	kb: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyB,
	task: 'debugCode',
	promptMaker: ({ path, language, startLine, endLine }) => makeUserPayload({
		task: 'debugCode', path, language, startLine, endLine, extra: { instruction: 'Identify potential bugs or logic errors and suggest fixes.' }
	})
});


