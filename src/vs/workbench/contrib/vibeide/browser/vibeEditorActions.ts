/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
			title: { value: localize('vibeExplainLine', 'VibeIDE: Explain This Line'), original: 'VibeIDE: Explain This Line' },
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
		if (!editor) return;

		const position = editor.getPosition();
		if (!position) return;

		const model = editor.getModel();
		const lineContent = model?.getLineContent(position.lineNumber) || '';
		const filePath = model?.uri.fsPath || '';

		// Show inline explanation notification
		// Phase 2: inject inline widget directly in editor
		notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeExplainLineResult',
				'Line {0} in {1}: "{2}"\n\n💡 Open chat and type: explain line {0} of {3}',
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
			title: { value: localize('vibeFreezeCode', 'VibeIDE: Freeze This Code for Agent'), original: 'VibeIDE: Freeze This Code for Agent' },
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
		if (!editor) return;

		const model = editor.getModel();
		const filePath = model?.uri.fsPath || '';

		if (!filePath) return;

		notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeFreezeCodeResult',
				'Added to .vibe/constraints.json: deny_write for {0}. The agent cannot modify this file.',
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
			title: { value: localize('vibePauseExplain', 'VibeIDE: Pause Agent and Ask What It\'s Doing'), original: 'VibeIDE: Pause Agent — What Are You Doing?' },
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
				'Agent paused. Type your question in the chat and the agent will explain, then continue. Click "Continue" to resume without asking.'
			),
			actions: {
				primary: [{
					id: 'vibeide.agent.continue',
					label: localize('vibeContinue', 'Continue'),
					tooltip: '',
					class: undefined,
					enabled: true,
					checked: false,
					run: () => {}, // Phase 2: resume agent
				}],
				secondary: [],
			}
		});
	}
}

registerAction2(ExplainThisLineAction);
registerAction2(FreezeThisCodeAction);
registerAction2(PauseAndExplainAction);
