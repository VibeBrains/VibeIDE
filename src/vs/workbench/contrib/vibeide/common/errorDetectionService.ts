/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CodeActionContext, CodeActionTriggerType, IWorkspaceTextEdit, TextEdit, WorkspaceEdit } from '../../../../editor/common/languages.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { autoModelFallbackProviderOrder, isValidProviderModelSelection, ModelSelection } from './vibeideSettingsTypes.js';

export const IErrorDetectionService = createDecorator<IErrorDetectionService>('errorDetectionService');

/**
 * Narrows a workspace-edit element to a text edit (as opposed to a file edit
 * or a custom edit), which is the only kind this service applies to the model.
 */
function isWorkspaceTextEdit(edit: WorkspaceEdit['edits'][number]): edit is IWorkspaceTextEdit {
	return Object.hasOwn(edit, 'resource') && Object.hasOwn(edit, 'textEdit');
}

export interface DetectedError {
	id: string;
	uri: URI;
	range: Range;
	message: string;
	code?: string;
	severity: 'error' | 'warning';
	source?: string;
	// Available fixes
	quickFixes?: Array<{
		title: string;
		edit: TextEdit[];
		kind?: string;
	}>;
	// LLM-generated fix (if no quick fix available)
	llmFix?: {
		description: string;
		diff: string;
	};
}

export interface ErrorFix {
	uri: URI;
	edits: TextEdit[];
	description: string;
}

export interface IErrorDetectionService {
	readonly _serviceBrand: undefined;

	/**
	 * Detect errors in a file and get available fixes
	 */
	detectErrorsInFile(uri: URI, token?: CancellationToken): Promise<DetectedError[]>;

	/**
	 * Get fixes for a specific error
	 */
	getFixesForError(error: DetectedError, token?: CancellationToken): Promise<ErrorFix[]>;

	/**
	 * Generate a minimal diff for fixing errors in a file
	 */
	generateFixDiff(uri: URI, errors: DetectedError[], token?: CancellationToken): Promise<ErrorFix | null>;
}

const ERROR_FIX_PROMPT = `You are a code fix assistant. Generate a minimal, safe fix for the following error(s).

Rules:
1. Generate ONLY the necessary changes to fix the error(s)
2. Use SEARCH/REPLACE format for minimal diffs
3. Do not change unrelated code
4. Preserve code style and formatting
5. Ensure the fix is safe and doesn't introduce new errors

Error(s) to fix:
{errors}

Current code:
\`\`\`
{code}
\`\`\`

Generate a minimal fix in SEARCH/REPLACE format:
SEARCH:
{oldCode}
REPLACE:
{newCode}

Return ONLY the SEARCH/REPLACE blocks, no explanations.`;

class ErrorDetectionService extends Disposable implements IErrorDetectionService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IVibeideSettingsService private readonly settingsService: IVibeideSettingsService,
	) {
		super();
	}

	async detectErrorsInFile(uri: URI, token: CancellationToken = CancellationToken.None): Promise<DetectedError[]> {
		const markers = this.markerService.read({ resource: uri });
		const errors: DetectedError[] = [];

		// Filter to errors and warnings only
		const relevantMarkers = markers.filter(m =>
			m.severity === MarkerSeverity.Error || m.severity === MarkerSeverity.Warning
		);

		if (relevantMarkers.length === 0) {
			return [];
		}

		// Get model for code actions
		let model: ITextModel | null = null;
		try {
			const modelRef = await this.textModelService.createModelReference(uri);
			model = modelRef.object.textEditorModel;

			for (const marker of relevantMarkers) {
				if (token.isCancellationRequested) { break; }

				const range = new Range(
					marker.startLineNumber,
					marker.startColumn,
					marker.endLineNumber,
					marker.endColumn
				);

				// Try to get quick fixes from code action providers
				const quickFixes = await this._getQuickFixes(model, range, token);

				const error: DetectedError = {
					id: `error-${uri.fsPath}-${marker.startLineNumber}-${marker.startColumn}`,
					uri,
					range,
					message: marker.message,
					code: typeof marker.code === 'string' ? marker.code : marker.code?.value,
					severity: marker.severity === MarkerSeverity.Error ? 'error' : 'warning',
					source: marker.source,
					quickFixes: quickFixes.length > 0 ? quickFixes : undefined,
				};

				errors.push(error);
			}

			modelRef.dispose();
		} catch (error) {
			vibeLog.error('errorDetection', '[ErrorDetectionService] Error detecting errors:', error);
		}

		return errors;
	}

	async getFixesForError(error: DetectedError, token: CancellationToken = CancellationToken.None): Promise<ErrorFix[]> {
		const fixes: ErrorFix[] = [];

		// Use quick fixes if available
		if (error.quickFixes && error.quickFixes.length > 0) {
			for (const quickFix of error.quickFixes) {
				fixes.push({
					uri: error.uri,
					edits: quickFix.edit,
					description: quickFix.title,
				});
			}
		}

		// If no quick fixes, try LLM-generated fix
		if (fixes.length === 0 && !error.llmFix) {
			const llmFix = await this._generateLLMFix(error, token);
			if (llmFix) {
				error.llmFix = llmFix;
				// Parse diff into TextEdits (simplified - would need proper diff parsing)
				// For now, return the LLM fix description
			}
		}

		return fixes;
	}

	async generateFixDiff(uri: URI, errors: DetectedError[], token: CancellationToken = CancellationToken.None): Promise<ErrorFix | null> {
		if (errors.length === 0) {
			return null;
		}

		// Try to use quick fixes first (preferred - more reliable)
		const quickFixErrors = errors.filter(e => e.quickFixes && e.quickFixes.length > 0);
		if (quickFixErrors.length > 0) {
			// Combine all quick fixes
			const allEdits: TextEdit[] = [];
			for (const error of quickFixErrors) {
				if (error.quickFixes && error.quickFixes[0]) {
					allEdits.push(...error.quickFixes[0].edit);
				}
			}

			if (allEdits.length > 0) {
				return {
					uri,
					edits: allEdits,
					description: localize('vibeide.errorDetection.quickFixDesc', "Исправить {0} ошибок(и) с помощью быстрых исправлений", quickFixErrors.length),
				};
			}
		}

		// Fall back to LLM-generated fix
		return await this._generateLLMFixForErrors(uri, errors, token);
	}

	private async _getQuickFixes(model: ITextModel, range: Range, token: CancellationToken): Promise<Array<{ title: string; edit: TextEdit[]; kind?: string }>> {
		const fixes: Array<{ title: string; edit: TextEdit[]; kind?: string }> = [];

		try {
			const providers = this.languageFeaturesService.codeActionProvider.ordered(model);
			const context: CodeActionContext = {
				trigger: CodeActionTriggerType.Invoke,
				only: 'quickfix',
			};

			for (const provider of providers) {
				if (token.isCancellationRequested) { break; }

				try {
					const actions = await provider.provideCodeActions(model, range, context, token);
					if (actions?.actions) {
						for (const action of actions.actions) {
							if (action.isPreferred && action.edit) {
								// Convert workspace edit to TextEdit[]
								const edits: TextEdit[] = [];
								if (Array.isArray(action.edit.edits)) {
									for (const edit of action.edit.edits) {
										// Check if it's a text edit (not a file edit)
										if (isWorkspaceTextEdit(edit)) {
											const textEdit = edit;
											if (textEdit.resource.toString() === model.uri.toString()) {
												edits.push({
													range: textEdit.textEdit.range,
													text: textEdit.textEdit.text,
												});
											}
										}
									}
								}

								if (edits.length > 0) {
									fixes.push({
										title: action.title,
										edit: edits,
										kind: action.kind,
									});
								}
							}
						}
					}
				} catch (error) {
					// Continue with other providers
					vibeLog.debug('errorDetection', '[ErrorDetectionService] Provider error:', error);
				}
			}
		} catch (error) {
			vibeLog.error('errorDetection', '[ErrorDetectionService] Error getting quick fixes:', error);
		}

		return fixes;
	}

	private async _generateLLMFix(error: DetectedError, token: CancellationToken): Promise<{ description: string; diff: string } | null> {
		// This would use LLM to generate a fix - simplified for now
		// Full implementation would call LLM with error context
		return null;
	}

	private async _generateLLMFixForErrors(uri: URI, errors: DetectedError[], token: CancellationToken): Promise<ErrorFix | null> {
		// Get file content
		let model: ITextModel | null = null;
		try {
			const modelRef = await this.textModelService.createModelReference(uri);
			model = modelRef.object.textEditorModel;
			const code = model.getValue();

			// Format errors for prompt
			const errorsText = errors.map(e =>
				`Line ${e.range.startLineNumber}: ${e.message} (${e.code || 'unknown'})`
			).join('\n');

			const prompt = ERROR_FIX_PROMPT
				.replace('{errors}', errorsText)
				.replace('{code}', code);

			// Get model selection
			const settings = this.settingsService.state;
			let modelSelection: ModelSelection = settings.modelSelectionOfFeature['Chat'] || { providerName: 'auto', modelName: 'auto' };

			// Resolve auto model selection
			if (modelSelection.providerName === 'auto' && modelSelection.modelName === 'auto') {
				for (const providerName of autoModelFallbackProviderOrder) {
					const providerSettings = settings.settingsOfProvider[providerName];
					if (providerSettings && providerSettings._didFillInProviderSettings) {
						const models = providerSettings.models || [];
						const firstModel = models.find(m => !m.isHidden);
						if (firstModel) {
							modelSelection = { providerName, modelName: firstModel.modelName };
							break;
						}
					}
				}
			}

			// Type guard: ensure modelSelection is valid (not "auto")
			if (!isValidProviderModelSelection(modelSelection)) {
				throw new Error('Invalid model selection. Please select a valid model in settings.');
			}

			const modelOptions = settings.optionsOfModelSelection['Chat']?.[modelSelection.providerName]?.[modelSelection.modelName];
			const overrides = settings.overridesOfModel;

			// Call LLM (simplified - would need proper parsing of SEARCH/REPLACE response)
			let isComplete = false;

			const requestId = this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				chatMode: 'normal',
				messages: [{ role: 'user', content: prompt }],
				separateSystemMessage: undefined,
				modelSelection,
				modelSelectionOptions: modelOptions,
				overridesOfModel: overrides,
				logging: { loggingName: 'Error Fix Generator', loggingExtras: { uri: uri.fsPath, errorCount: errors.length } },
				onText: () => {
					// Response will be available in onFinalMessage
				},
				onFinalMessage: () => {
					isComplete = true;
				},
				onError: () => {
					isComplete = true;
				},
				onAbort: () => {
					isComplete = true;
				},
			});

			// Wait for completion
			while (!isComplete && !token.isCancellationRequested) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}

			if (token.isCancellationRequested) {
				this.llmMessageService.abort(requestId || '');
				return null;
			}

			// Parse response to extract TextEdits (simplified - would need proper diff parsing)
			// For now, return a placeholder
			modelRef.dispose();
			return {
				uri,
				edits: [], // Would parse SEARCH/REPLACE blocks into TextEdits
				description: localize('vibeide.errorDetection.llmFixDesc', "Исправление {0} ошибок(и), сгенерированное LLM", errors.length),
			};
		} catch (error) {
			vibeLog.error('errorDetection', '[ErrorDetectionService] Error generating LLM fix:', error);
			return null;
		}
	}
}

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

registerSingleton(IErrorDetectionService, ErrorDetectionService, InstantiationType.Delayed);

