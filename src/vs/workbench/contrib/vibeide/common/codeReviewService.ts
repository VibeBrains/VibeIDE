/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ModelSelection } from './vibeideSettingsTypes.js';
import { describeAgreement, mergeReviewAnnotations } from './reviewFindingMerge.js';

export const ICodeReviewService = createDecorator<ICodeReviewService>('codeReviewService');

/**
 * Severity levels for code review annotations
 */
export type ReviewSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * Categories of code review annotations
 */
export type ReviewCategory = 'suggestion' | 'test' | 'smell' | 'security' | 'performance' | 'style' | 'bug';

/**
 * A code review annotation with line anchor and actionable suggestion
 */
export interface CodeReviewAnnotation {
	/** Unique identifier for this annotation */
	id: string;
	/** Line number (1-based) where the annotation applies */
	line: number;
	/** Optional column range for more precise location */
	range?: Range;
	/** Severity level */
	severity: ReviewSeverity;
	/** Category of the issue */
	category: ReviewCategory;
	/** Human-readable message describing the issue */
	message: string;
	/** Optional suggested fix (code snippet) */
	suggestedFix?: string;
	/** Optional explanation of why this is an issue */
	explanation?: string;
	/** Optional test suggestion */
	testSuggestion?: string;
}

/**
 * Result of a code review operation
 */
export interface CodeReviewResult {
	/** URI of the reviewed file */
	uri: URI;
	/** List of annotations found */
	annotations: CodeReviewAnnotation[];
	/** Overall summary of the review */
	summary: string;
	/** Whether the review completed successfully */
	success: boolean;
	/** Error message if review failed */
	error?: string;
}

export interface ICodeReviewService {
	readonly _serviceBrand: undefined;

	/**
	 * Review a file and generate inline annotations
	 * @param uri URI of the file to review
	 * @param token Cancellation token
	 * @returns Promise resolving to review result with annotations
	 */
	reviewFile(uri: URI, token?: CancellationToken): Promise<CodeReviewResult>;

	/**
	 * Review multiple files (e.g., for PR review)
	 * @param uris Array of URIs to review
	 * @param token Cancellation token
	 * @returns Promise resolving to review results for each file
	 */
	reviewFiles(uris: URI[], token?: CancellationToken): Promise<CodeReviewResult[]>;
}

/**
 * Default prompt for code review
 */
const CODE_REVIEW_PROMPT = `You are a code reviewer. Analyze the following code and provide specific, actionable feedback.

For each issue found, provide:
1. Line number (1-based)
2. Severity: error, warning, info, or hint
3. Category: suggestion, test, smell, security, performance, style, or bug
4. Clear message describing the issue
5. Optional suggested fix (code snippet)
6. Optional explanation

Format your response as a JSON array of annotations:
[
  {
    "line": 42,
    "severity": "warning",
    "category": "smell",
    "message": "Function is too long (150 lines). Consider breaking it into smaller functions.",
    "suggestedFix": "// Extract helper functions...",
    "explanation": "Long functions are harder to test and maintain."
  }
]

Be concise but thorough. Focus on:
- Code smells and maintainability issues
- Security vulnerabilities
- Performance problems
- Missing or inadequate tests
- Style inconsistencies
- Potential bugs

Return ONLY the JSON array, no markdown formatting.`;

class CodeReviewService extends Disposable implements ICodeReviewService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IVibeideSettingsService private readonly settingsService: IVibeideSettingsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	async reviewFile(uri: URI, token: CancellationToken = CancellationToken.None): Promise<CodeReviewResult> {
		try {
			// Get file content
			const model = this.modelService.getModel(uri);
			if (!model) {
				return {
					uri,
					annotations: [],
					summary: 'File not found or not open',
					success: false,
					error: 'File model not available',
				};
			}

			const fileContent = model.getValue();
			if (!fileContent.trim()) {
				return {
					uri,
					annotations: [],
					summary: 'File is empty',
					success: true,
				};
			}

			// Get file language for context
			const languageId = model.getLanguageId();
			const fileName = uri.fsPath.split('/').pop() || 'file';

			// Build review prompt with file context
			const reviewPrompt = `${CODE_REVIEW_PROMPT}

File: ${fileName}
Language: ${languageId}

Code to review:
\`\`\`${languageId}
${fileContent}
\`\`\`

Provide your review annotations as a JSON array:`;

			// Get model selection from settings (use Chat feature model selection)
			const settings = this.settingsService.state;
			const modelSelection = this.settingsService.resolveAutoModelSelection(
				settings.modelSelectionOfFeature['Chat'] || { providerName: 'auto', modelName: 'auto' }
			);

			if (!modelSelection || modelSelection.providerName === 'auto') {
				return {
					uri,
					annotations: [],
					summary: 'No model provider configured. Please configure a model provider in VibeIDE Settings.',
					success: false,
					error: 'No models available',
				};
			}

			// Панель моделей: одна и та же диффа уходит нескольким провайдерам параллельно, а находки
			// сливаются по согласию. Одиночная модель как детектор уязвимостей ненадёжна — это вывод
			// рецензируемого исследования, а не наше впечатление: она уверенно называет дырой
			// безопасный код и так же уверенно пропускает настоящую. Несколько моделей дают то, чего
			// у одной нет в принципе — согласие, и именно оно показывается в отчёте.
			const panel = this._resolveReviewPanel(modelSelection);
			const runs = await Promise.all(panel.map(async selection => {
				const options = settings.optionsOfModelSelection['Chat']?.[selection.providerName]?.[selection.modelName];
				const outcome = await this._askModel(selection, options, settings.overridesOfModel, reviewPrompt, fileName, model, token);
				return { model: `${selection.providerName}/${selection.modelName}`, outcome };
			}));

			const succeeded = runs.filter(r => !r.outcome.error);
			if (succeeded.length === 0) {
				return {
					uri,
					annotations: [],
					summary: 'Review failed',
					success: false,
					// Модели могли упасть по-разному; называем все причины, иначе «не сработало»
					// невозможно чинить.
					error: runs.map(r => `${r.model}: ${r.outcome.error}`).join('; ') || 'Unknown error',
				};
			}

			const minAgreement = Math.max(1, this._configurationService.getValue<number>('vibeide.codeReview.minAgreement') ?? 2);
			const merged = mergeReviewAnnotations(succeeded.map(r => ({ model: r.model, annotations: r.outcome.annotations })), minAgreement);
			// Согласие дописывается в объяснение находки: это то, чем мультимодельный отчёт отличается
			// от одиночного, и прятать его в отдельном поле, которого никто не рендерит, бессмысленно.
			const annotations: CodeReviewAnnotation[] = merged.map(item => {
				const agreement = describeAgreement(item, succeeded.length);
				const extra = [agreement, ...item.otherMessages.map(m => `иначе: ${m}`)].filter(Boolean).join(' · ');
				return extra ? { ...item, explanation: item.explanation ? `${item.explanation}\n${extra}` : extra } : { ...item };
			});

			const summary = this._generateSummary(annotations);

			return {
				uri,
				annotations,
				summary,
				success: true,
			};
		} catch (error) {
			return {
				uri,
				annotations: [],
				summary: 'Review failed',
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Один прогон ревью одной моделью.
	 *
	 * Вынесено из `reviewFile` целиком ради панели: раньше запрос был вшит в метод, и второй
	 * провайдер потребовал бы копии всего блока вместе с таймаутом и опросом отмены.
	 */
	private async _askModel(
		modelSelection: ModelSelection,
		modelOptions: unknown,
		overrides: unknown,
		reviewPrompt: string,
		fileName: string,
		model: ITextModel,
		token: CancellationToken,
	): Promise<{ annotations: CodeReviewAnnotation[]; error?: string }> {
		let response = '';
		let isComplete = false;
		let errorMessage: string | undefined;

		const requestId = this.llmMessageService.sendLLMMessage({
			messagesType: 'chatMessages',
			chatMode: 'normal',
			messages: [
				{ role: 'system', content: CODE_REVIEW_PROMPT },
				{ role: 'user', content: reviewPrompt },
			],
			modelSelection,
			modelSelectionOptions: modelOptions as never,
			overridesOfModel: overrides as never,
			separateSystemMessage: CODE_REVIEW_PROMPT,
			logging: { loggingName: 'Code Review', loggingExtras: { file: fileName, model: `${modelSelection.providerName}/${modelSelection.modelName}` } },
			onText: ({ fullText }) => {
				response = fullText;
				if (token.isCancellationRequested) {
					this.llmMessageService.abort(requestId || '');
				}
			},
			onFinalMessage: ({ fullText }) => {
				response = fullText;
				isComplete = true;
			},
			onError: ({ message }) => {
				errorMessage = message;
				isComplete = true;
			},
			onAbort: () => {
				isComplete = true;
			},
		});

		if (!requestId) {
			return { annotations: [], error: 'Could not initialize LLM service' };
		}

		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				if (!isComplete) {
					this.llmMessageService.abort(requestId);
					errorMessage = 'Timeout after 30 seconds';
					isComplete = true;
				}
				resolve();
			}, 30000);

			const checkInterval = setInterval(() => {
				if (token.isCancellationRequested) {
					clearInterval(checkInterval);
					clearTimeout(timeout);
					if (!isComplete) {
						this.llmMessageService.abort(requestId);
					}
					isComplete = true;
					resolve();
					return;
				}
				if (isComplete) {
					clearInterval(checkInterval);
					clearTimeout(timeout);
					resolve();
				}
			}, 100);
		});

		if (errorMessage) {
			return { annotations: [], error: errorMessage };
		}
		return { annotations: this._parseReviewResponse(response, model) };
	}

	/**
	 * Кого спрашивать. Пусто в настройке — прежнее поведение, одна модель чата: молча звать три
	 * провайдера там, где пользователь настроил одного, значит втрое увеличить его счёт без спроса.
	 */
	private _resolveReviewPanel(fallback: ModelSelection): ModelSelection[] {
		const raw = this._configurationService.getValue<string[]>('vibeide.codeReview.models');
		if (!Array.isArray(raw) || raw.length === 0) {
			return [fallback];
		}
		const panel: ModelSelection[] = [];
		for (const entry of raw) {
			if (typeof entry !== 'string') { continue; }
			// Форма `provider:model`; двоеточие в имени модели допустимо, поэтому режем по первому.
			const at = entry.indexOf(':');
			if (at <= 0 || at === entry.length - 1) { continue; }
			const providerName = entry.slice(0, at).trim();
			const modelName = entry.slice(at + 1).trim();
			if (providerName && modelName) {
				panel.push({ providerName, modelName } as ModelSelection);
			}
		}
		return panel.length > 0 ? panel : [fallback];
	}

	async reviewFiles(uris: URI[], token: CancellationToken = CancellationToken.None): Promise<CodeReviewResult[]> {
		const results: CodeReviewResult[] = [];

		for (const uri of uris) {
			if (token.isCancellationRequested) {
				break;
			}

			const result = await this.reviewFile(uri, token);
			results.push(result);
		}

		return results;
	}

	/**
	 * Parse LLM response to extract code review annotations
	 */
	private _parseReviewResponse(response: string, model: ITextModel): CodeReviewAnnotation[] {
		const annotations: CodeReviewAnnotation[] = [];

		try {
			// Try to extract JSON from response (may be wrapped in markdown code blocks)
			let jsonStr = response.trim();

			// Remove markdown code blocks if present
			const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
			if (codeBlockMatch) {
				jsonStr = codeBlockMatch[1].trim();
			}

			// Parse JSON
			const parsed = JSON.parse(jsonStr);

			if (!Array.isArray(parsed)) {
				return annotations;
			}

			// Validate and convert to annotations
			for (const item of parsed) {
				if (typeof item !== 'object' || !item.line || !item.severity || !item.category || !item.message) {
					continue;
				}

				const line = Number(item.line);
				if (isNaN(line) || line < 1 || line > model.getLineCount()) {
					continue;
				}

				// Validate severity
				const severity = ['error', 'warning', 'info', 'hint'].includes(item.severity)
					? item.severity as ReviewSeverity
					: 'info';

				// Validate category
				const category = ['suggestion', 'test', 'smell', 'security', 'performance', 'style', 'bug'].includes(item.category)
					? item.category as ReviewCategory
					: 'suggestion';

				// Create range for the line
				const lineStart = new Position(line, 1);
				const lineEnd = new Position(line, model.getLineMaxColumn(line));
				const range = new Range(lineStart.lineNumber, lineStart.column, lineEnd.lineNumber, lineEnd.column);

				annotations.push({
					id: `review-${line}-${annotations.length}`,
					line,
					range,
					severity,
					category,
					message: String(item.message),
					suggestedFix: item.suggestedFix ? String(item.suggestedFix) : undefined,
					explanation: item.explanation ? String(item.explanation) : undefined,
					testSuggestion: item.testSuggestion ? String(item.testSuggestion) : undefined,
				});
			}
		} catch (error) {
			// If parsing fails, try to extract annotations from natural language response
			// This is a fallback - ideally the LLM should return JSON
			vibeLog.warn('codeReview', 'Failed to parse review response as JSON:', error);
		}

		return annotations;
	}

	/**
	 * Generate a summary of the review
	 */
	private _generateSummary(annotations: CodeReviewAnnotation[]): string {
		if (annotations.length === 0) {
			return 'No issues found. Code looks good!';
		}

		const errorCount = annotations.filter(a => a.severity === 'error').length;
		const warningCount = annotations.filter(a => a.severity === 'warning').length;
		const infoCount = annotations.filter(a => a.severity === 'info').length;
		const hintCount = annotations.filter(a => a.severity === 'hint').length;

		const parts: string[] = [];
		if (errorCount > 0) { parts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`); }
		if (warningCount > 0) { parts.push(`${warningCount} warning${warningCount > 1 ? 's' : ''}`); }
		if (infoCount > 0) { parts.push(`${infoCount} info${infoCount > 1 ? 's' : ''}`); }
		if (hintCount > 0) { parts.push(`${hintCount} hint${hintCount > 1 ? 's' : ''}`); }

		return `Found ${annotations.length} issue${annotations.length > 1 ? 's' : ''}: ${parts.join(', ')}`;
	}
}

registerSingleton(ICodeReviewService, CodeReviewService, InstantiationType.Delayed);

