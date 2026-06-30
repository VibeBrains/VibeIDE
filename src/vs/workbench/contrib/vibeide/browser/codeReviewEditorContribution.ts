/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { IModelDecorationOptions, ITextModel } from '../../../../editor/common/model.js';
import { Range } from '../../../../editor/common/core/range.js';
import { URI } from '../../../../base/common/uri.js';
import { CodeReviewAnnotation, ReviewSeverity } from '../common/codeReviewService.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverAction } from '../../../../base/browser/ui/hover/hover.js';

/**
 * Editor contribution that displays code review annotations inline
 */
export class CodeReviewEditorContribution extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.codeReview';

	public static get(editor: ICodeEditor): CodeReviewEditorContribution | null {
		return editor.getContribution<CodeReviewEditorContribution>(CodeReviewEditorContribution.ID);
	}

	private _annotations: Map<string, CodeReviewAnnotation[]> = new Map(); // URI -> annotations
	private _decorationIds: string[] = [];
	private _hoverDisposables: Disposable[] = [];

	constructor(
		private readonly _editor: ICodeEditor,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();

		// Listen for model changes to update decorations
		this._register(this._editor.onDidChangeModel(() => {
			this._updateDecorations();
		}));

		// Listen for settings changes
		this._register(this._settingsService.onDidChangeState(() => {
			this._updateDecorations();
		}));
	}

	/**
	 * Set annotations for the current file
	 */
	public setAnnotations(uri: URI, annotations: CodeReviewAnnotation[]): void {
		this._annotations.set(uri.toString(), annotations);
		this._updateDecorations();
	}

	/**
	 * Clear annotations for the current file
	 */
	public clearAnnotations(uri: URI): void {
		this._annotations.delete(uri.toString());
		this._updateDecorations();
	}

	/**
	 * Get annotations for the current file
	 */
	public getAnnotations(uri: URI): CodeReviewAnnotation[] {
		return this._annotations.get(uri.toString()) || [];
	}

	private _updateDecorations(): void {
		const model = this._editor.getModel();
		if (!model) {
			this._clearDecorations();
			return;
		}

		const uri = model.uri;
		const annotations = this._annotations.get(uri.toString()) || [];

		// Check if inline code review is enabled (default to true if not configured)
		const settings = this._settingsService.state;
		const enableInlineCodeReview = settings.globalSettings.enableInlineCodeReview ?? true;
		if (!enableInlineCodeReview) {
			this._clearDecorations();
			return;
		}

		// Filter by severity if configured
		const severityFilter = settings.globalSettings.reviewSeverityFilter || 'all';
		const filteredAnnotations = this._filterBySeverity(annotations, severityFilter);

		if (filteredAnnotations.length === 0) {
			this._clearDecorations();
			return;
		}

		// Create decorations for each annotation
		const decorations: Array<{ range: Range; options: IModelDecorationOptions }> = [];

		for (const annotation of filteredAnnotations) {
			const range = annotation.range || new Range(annotation.line, 1, annotation.line, model.getLineMaxColumn(annotation.line));

			// Determine decoration class based on severity
			const className = this._getDecorationClassName(annotation.severity);

			// Create hover content with actions
			const hoverData = this._createHoverContent(annotation, uri);

			decorations.push({
				range,
				options: {
					className,
					hoverMessage: hoverData.content,
					description: `Code Review: ${annotation.category}`,
					isWholeLine: true,
					glyphMarginClassName: this._getGlyphMarginClassName(annotation.severity),
					glyphMarginHoverMessage: hoverData.content,
					stickiness: 1, // TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
				},
			});

			// Note: Actions are available via context menu (right-click on annotation)
		}

		// Apply decorations
		this._clearDecorations();
		const newDecorationIds = model.changeDecorations((accessor) => {
			return decorations.map(d => accessor.addDecoration(d.range, d.options));
		});
		this._decorationIds = newDecorationIds || [];

		// Setup hover handlers for actions
		this._setupHoverHandlers(model, filteredAnnotations);
	}

	private _filterBySeverity(annotations: CodeReviewAnnotation[], filter: string): CodeReviewAnnotation[] {
		if (filter === 'all') {
			return annotations;
		}
		if (filter === 'warning+error') {
			return annotations.filter(a => a.severity === 'warning' || a.severity === 'error');
		}
		return annotations;
	}

	private _getDecorationClassName(severity: ReviewSeverity): string {
		switch (severity) {
			case 'error':
				return 'code-review-error';
			case 'warning':
				return 'code-review-warning';
			case 'info':
				return 'code-review-info';
			case 'hint':
				return 'code-review-hint';
			default:
				return 'code-review-info';
		}
	}

	private _getGlyphMarginClassName(severity: ReviewSeverity): string {
		switch (severity) {
			case 'error':
				return 'code-review-glyph-error';
			case 'warning':
				return 'code-review-glyph-warning';
			case 'info':
				return 'code-review-glyph-info';
			case 'hint':
				return 'code-review-glyph-hint';
			default:
				return 'code-review-glyph-info';
		}
	}

	private _createHoverContent(annotation: CodeReviewAnnotation, uri: URI): { content: MarkdownString; actions?: IHoverAction[] } {
		const parts: string[] = [];

		// Title with severity
		parts.push(`**${annotation.severity.toUpperCase()}**: ${annotation.category}`);

		// Message
		parts.push(`\n${annotation.message}`);

		// Explanation if available
		if (annotation.explanation) {
			parts.push(`\n\n*${annotation.explanation}*`);
		}

		// Suggested fix if available
		if (annotation.suggestedFix) {
			parts.push(`\n\n**Suggested Fix:**`);
			parts.push(`\`\`\`\n${annotation.suggestedFix}\n\`\`\``);
		}

		// Test suggestion if available
		if (annotation.testSuggestion) {
			parts.push(`\n\n**Test Suggestion:**`);
			parts.push(`\`\`\`\n${annotation.testSuggestion}\n\`\`\``);
		}

		const markdown = new MarkdownString(parts.join('\n'), true);
		markdown.isTrusted = true;

		// Add "Apply fix" action if suggested fix is available
		const actions: IHoverAction[] | undefined = annotation.suggestedFix ? [{
			label: 'Apply Fix',
			commandId: 'vibe.codeReview.applyFix',
			iconClass: 'codicon-check',
			run: () => {
				this._commandService.executeCommand('vibe.codeReview.applyFix', annotation, uri);
			},
		}] : undefined;

		return { content: markdown, actions };
	}

	private _setupHoverHandlers(model: ITextModel, annotations: CodeReviewAnnotation[]): void {
		// Dispose previous hover handlers
		this._hoverDisposables.forEach(d => d.dispose());
		this._hoverDisposables = [];

		// For now, we'll handle hover actions through the hover service
		// The actual "Apply fix" action will be implemented in the command
	}

	private _clearDecorations(): void {
		const model = this._editor.getModel();
		if (model && this._decorationIds.length > 0) {
			model.changeDecorations((accessor) => {
				for (const id of this._decorationIds) {
					accessor.removeDecoration(id);
				}
			});
			this._decorationIds = [];
		}
		this._hoverDisposables.forEach(d => d.dispose());
		this._hoverDisposables = [];
	}

	override dispose(): void {
		this._clearDecorations();
		this._annotations.clear();
		super.dispose();
	}
}

// Register the contribution
registerEditorContribution(CodeReviewEditorContribution.ID, CodeReviewEditorContribution, EditorContributionInstantiation.Lazy);

