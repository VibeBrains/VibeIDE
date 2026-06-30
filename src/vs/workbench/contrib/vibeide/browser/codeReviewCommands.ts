/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Action2, registerAction2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ICodeReviewService, CodeReviewAnnotation } from '../common/codeReviewService.js';
import { CodeReviewEditorContribution } from './codeReviewEditorContribution.js';
import { IProgressService, ProgressLocation, IProgress, IProgressStep } from '../../../../platform/progress/common/progress.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { localize, localize2 } from '../../../../nls.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * Command to review the current file
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibe.codeReview.reviewFile',
			f1: true,
			title: localize2('vibeCodeReviewFile', 'VibeIDE: Провести код-ревью этого файла'),
			category: localize2('vibeCategory', 'VibeIDE'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR,
				weight: KeybindingWeight.ExternalExtension,
				when: ContextKeyExpr.deserialize('editorFocus && !terminalFocus'),
			},
			menu: {
				id: MenuId.EditorContext,
				group: '1_modification',
				order: 2,
				when: ContextKeyExpr.deserialize('editorTextFocus && !terminalFocus'),
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(ICodeEditorService);
		const codeReviewService = accessor.get(ICodeReviewService);
		const progressService = accessor.get(IProgressService);
		const notificationService = accessor.get(INotificationService);

		const editor = editorService.getFocusedCodeEditor();
		if (!editor || !editor.hasModel()) {
			notificationService.warn('No editor is focused');
			return;
		}

		const uri = editor.getModel().uri;
		const fileName = uri.fsPath.split('/').pop() || 'file';

		// Create cancellation token source
		const cancellationTokenSource = new CancellationTokenSource();

		// Show progress
		await progressService.withProgress(
			{
				location: ProgressLocation.Notification,
				title: localize('vibeide.codeReview.progress', 'Код-ревью: {0}…', fileName),
				cancellable: true,
			},
			async (progress: IProgress<IProgressStep>) => {
				try {
					progress.report({ message: localize('vibeide.codeReview.analyzing', 'Анализ кода…') });

					// Perform review
					const result = await codeReviewService.reviewFile(uri, cancellationTokenSource.token);

					if (cancellationTokenSource.token.isCancellationRequested) {
						return;
					}

					if (!result.success) {
						notificationService.error(`Code review failed: ${result.error || 'Unknown error'}`);
						return;
					}

					// Get the editor contribution and set annotations
					const contribution = CodeReviewEditorContribution.get(editor);
					if (contribution) {
						contribution.setAnnotations(uri, result.annotations);
						progress.report({ message: localize('vibeide.codeReview.foundIssues', 'Найдено замечаний: {0}', result.annotations.length) });
					}

					// Show notification with summary
					if (result.annotations.length === 0) {
						notificationService.info(`✅ ${fileName}: No issues found!`);
					} else {
						notificationService.info(`📋 ${fileName}: ${result.summary}`);
					}
				} catch (error) {
					notificationService.error(`Code review error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
			() => {
				// onDidCancel callback
				cancellationTokenSource.cancel();
			}
		);
	}
});

/**
 * Command to apply a suggested fix from a code review annotation
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibe.codeReview.applyFix',
			f1: false, // Not in command palette, called programmatically
			title: localize2('vibeCodeReviewApplyFix', 'VibeIDE: Применить исправление'),
		});
	}

	async run(accessor: ServicesAccessor, annotation: CodeReviewAnnotation, uri: URI): Promise<void> {
		if (!annotation.suggestedFix) {
			return;
		}

		const notificationService = accessor.get(INotificationService);

		try {
			const message = [
				`Suggested fix (${uri.fsPath}):`,
				annotation.message,
				'',
				annotation.suggestedFix,
				'',
				'Use VibeIDE chat to apply this suggestion in context.',
			].join('\n');
			notificationService.info(message);

		} catch (error) {
			notificationService.error(`Failed to apply fix: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
});

