/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IErrorDetectionService, DetectedError } from '../common/errorDetectionService.js';
import { IProgressService, IProgress, IProgressStep, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { ErrorDetectionEditorContribution } from './errorDetectionEditorContribution.js';
import { CancellationTokenSource, CancellationToken } from '../../../../base/common/cancellation.js';

/**
 * Command to detect errors in the active editor
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibe.errorDetection.detectErrors',
			title: localize2('vibeErrorDetectionDetectErrors', 'VibeIDE: Обнаружить ошибки'),
			f1: true,
			keybinding: {
				weight: 100,
				primary: 0,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(ICodeEditorService);
		const errorDetectionService = accessor.get(IErrorDetectionService);
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
				title: localize('vibeide.errorDetection.progress', 'Обнаружение ошибок в {0}…', fileName),
				cancellable: true,
			},
			async (progress: IProgress<IProgressStep>) => {
				try {
					progress.report({ message: localize('vibeide.errorDetection.scanning', 'Сканирование ошибок…') });

					// Detect errors
					const errors = await errorDetectionService.detectErrorsInFile(uri, cancellationTokenSource.token);

					if (cancellationTokenSource.token.isCancellationRequested) {
						return;
					}

					// Get the editor contribution and set errors
					const contribution = ErrorDetectionEditorContribution.get(editor);
					if (contribution) {
						contribution.setErrors(uri, errors);
						progress.report({ message: localize('vibeide.errorDetection.foundErrors', 'Найдено ошибок: {0}', errors.length) });
					}

					// Show notification with summary
					if (errors.length === 0) {
						notificationService.info(`✅ ${fileName}: No errors found!`);
					} else {
						const errorCount = errors.filter(e => e.severity === 'error').length;
						const warningCount = errors.filter(e => e.severity === 'warning').length;
						notificationService.info(`📋 ${fileName}: ${errorCount} error(s), ${warningCount} warning(s)`);
					}
				} catch (error) {
					notificationService.error(`Error detection failed: ${error instanceof Error ? error.message : String(error)}`);
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
 * Command to apply a fix for an error
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibe.errorDetection.applyFix',
			f1: false, // Not in command palette, called programmatically
			title: localize2('vibeErrorDetectionApplyFix', 'VibeIDE: Применить исправление'),
		});
	}

	async run(accessor: ServicesAccessor, error: DetectedError, uri: URI): Promise<void> {
		const errorDetectionService = accessor.get(IErrorDetectionService);
		const notificationService = accessor.get(INotificationService);

		try {
			// Get fixes for the error
			const fixes = await errorDetectionService.getFixesForError(error, CancellationToken.None);

			if (fixes.length === 0) {
				notificationService.info('No fixes available for this error');
				return;
			}

			// Use the first fix (preferred fix)
			const fix = fixes[0];
			const message = [
				`Suggested fix (${uri.fsPath}): ${fix.description}`,
				'',
				`Error: ${error.message}`,
				error.code ? `Code: ${error.code}` : '',
				'Use VibeIDE chat to apply this fix in context.',
			].filter(Boolean).join('\n');
			notificationService.info(message);

		} catch (error) {
			notificationService.error(`Failed to apply fix: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
});

