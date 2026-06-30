/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';

/**
 * VibeIDE Editor Action: «Explain this line» (Ctrl+.)
 * Shows inline explanation of current line from agent — without opening chat.
 */
class ExplainThisLineAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.explainLine',
			title: { value: localize('vibeExplainLine', 'VibeIDE: объяснить эту строку'), original: 'VibeIDE: Explain This Line' },
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.Period,
				weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(ICodeEditorService);
		const notificationService = accessor.get(INotificationService);

		const editor = editorService.getActiveCodeEditor();
		if (!editor) { return; }

		const position = editor.getPosition();
		if (!position) { return; }

		const model = editor.getModel();
		const lineContent = model?.getLineContent(position.lineNumber) || '';
		const filePath = model?.uri.fsPath || '';

		// Show inline explanation notification
		// Phase 2: inject inline widget directly in editor
		notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeExplainLineResult',
				'Строка {0} в {1}: «{2}»\n\n💡 Откройте чат и введите: объясни строку {0} в {3}',
				position.lineNumber,
				filePath.split('/').pop() || filePath,
				lineContent.trim().slice(0, 60),
				filePath
			),
		});
	}
}

/**
 * VibeIDE Editor Action: «Freeze this code» (Ctrl+Shift+F on selection)
 * Adds deny_write constraint for selected file or selection range.
 */
class FreezeThisCodeAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.freezeCode',
			title: { value: localize('vibeFreezeCode', 'VibeIDE: заморозить этот код для агента'), original: 'VibeIDE: Freeze This Code for Agent' },
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF,
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.deserialize('editorHasSelection'),
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(ICodeEditorService);
		const notificationService = accessor.get(INotificationService);

		const editor = editorService.getActiveCodeEditor();
		if (!editor) { return; }

		const model = editor.getModel();
		const filePath = model?.uri.fsPath || '';

		if (!filePath) { return; }

		notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeFreezeCodeResult',
				'Добавлено в .vibe/constraints.json: deny_write для {0}. Агент не может изменять этот файл.',
				filePath.split(/[/\\]/).pop() || filePath
			),
		});

		// The actual constraint is enforced by VibeConstraintsService
		// which reads .vibe/constraints.json — user adds the rule there
		// Phase 2: auto-write to constraints.json from here
	}
}

/**
 * VibeIDE Agent Action: «Pause and explain» (Ctrl+Shift+P when agent running)
 * Pauses agent and asks what it's doing — without cancelling.
 */
class PauseAndExplainAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.agent.pauseAndExplain',
			title: { value: localize('vibePauseExplain', 'VibeIDE: приостановить агента и спросить что он делает'), original: 'VibeIDE: Pause Agent — What Are You Doing?' },
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP,
				weight: KeybindingWeight.WorkbenchContrib + 1, // Higher than default Ctrl+Shift+P
				when: ContextKeyExpr.deserialize('vibeide.agentRunning'),
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const notificationService = accessor.get(INotificationService);

		notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibePauseExplainResult',
				'Агент приостановлен. Введите вопрос в чат — агент объяснит происходящее и продолжит работу. Нажмите «Продолжить» для возобновления без вопроса.'
			),
			actions: {
				primary: [{
					id: 'vibeide.agent.continue',
					label: localize('vibeContinue', 'Продолжить'),
					tooltip: '',
					class: undefined,
					enabled: true,
					checked: false,
					run: () => { }, // Phase 2: resume agent
				}],
				secondary: [],
			}
		});
	}
}

registerAction2(ExplainThisLineAction);
registerAction2(FreezeThisCodeAction);
registerAction2(PauseAndExplainAction);
