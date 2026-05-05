/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { IModelDecorationOptions } from '../../../../editor/common/model.js';
import { Range } from '../../../../editor/common/core/range.js';
import { URI } from '../../../../base/common/uri.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IErrorDetectionService, DetectedError } from '../common/errorDetectionService.js';
import { Emitter, Event } from '../../../../base/common/event.js';

/**
 * Editor contribution that displays error highlights with "Fix" buttons
 */
export class ErrorDetectionEditorContribution extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.errorDetection';

	public static get(editor: ICodeEditor): ErrorDetectionEditorContribution | null {
		return editor.getContribution<ErrorDetectionEditorContribution>(ErrorDetectionEditorContribution.ID);
	}

	private _errors: Map<string, DetectedError[]> = new Map(); // URI -> errors
	private _decorationIds: string[] = [];
	private readonly _onDidChangeErrors = new Emitter<{ uri: URI; errors: DetectedError[] }>();
	public readonly onDidChangeErrors: Event<{ uri: URI; errors: DetectedError[] }> = this._onDidChangeErrors.event;

	constructor(
		private readonly _editor: ICodeEditor,
		@IErrorDetectionService private readonly _errorDetectionService: IErrorDetectionService,
	) {
		super();

		// Listen for model changes to update decorations
		this._register(this._editor.onDidChangeModel(() => {
			this._updateDecorations();
		}));

		// Auto-detect errors when model changes
		this._register(this._editor.onDidChangeModel(async () => {
			const model = this._editor.getModel();
			if (model) {
				await this.detectErrors(model.uri);
			}
		}));
	}

	/**
	 * Detect errors in the current file
	 */
	public async detectErrors(uri: URI): Promise<void> {
		try {
			const errors = await this._errorDetectionService.detectErrorsInFile(uri);
			this.setErrors(uri, errors);
		} catch (error) {
			console.error('[ErrorDetectionEditorContribution] Error detecting errors:', error);
		}
	}

	/**
	 * Set errors for the current file
	 */
	public setErrors(uri: URI, errors: DetectedError[]): void {
		this._errors.set(uri.toString(), errors);
		this._updateDecorations();
		this._onDidChangeErrors.fire({ uri, errors });
	}

	/**
	 * Clear errors for the current file
	 */
	public clearErrors(uri: URI): void {
		this._errors.delete(uri.toString());
		this._updateDecorations();
		this._onDidChangeErrors.fire({ uri, errors: [] });
	}

	/**
	 * Get errors for the current file
	 */
	public getErrors(uri: URI): DetectedError[] {
		return this._errors.get(uri.toString()) || [];
	}

	private _updateDecorations(): void {
		const model = this._editor.getModel();
		if (!model) {
			this._clearDecorations();
			return;
		}

		const uri = model.uri;
		const errors = this._errors.get(uri.toString()) || [];

		if (errors.length === 0) {
			this._clearDecorations();
			return;
		}

		// Create decorations for each error
		const decorations: Array<{ range: Range; options: IModelDecorationOptions }> = [];

		for (const error of errors) {
			const range = error.range;

			// Determine decoration class based on severity
			const className = error.severity === 'error'
				? 'error-detection-error'
				: 'error-detection-warning';

			// Create hover content with actions
			const hoverData = this._createHoverContent(error, uri);

			decorations.push({
				range,
				options: {
					className,
					hoverMessage: hoverData.content,
					description: `Error: ${error.message}`,
					isWholeLine: false,
					glyphMarginClassName: this._getGlyphMarginClassName(error.severity),
					glyphMarginHoverMessage: hoverData.content,
					stickiness: 1,
				},
			});
		}

		// Apply decorations
		this._clearDecorations();
		const newDecorationIds = model.changeDecorations(accessor => {
			return decorations.map(d => accessor.addDecoration(d.range, d.options));
		});
		this._decorationIds = newDecorationIds || [];
	}

	private _clearDecorations(): void {
		const model = this._editor.getModel();
		if (model && this._decorationIds.length > 0) {
			model.changeDecorations(accessor => {
				for (const id of this._decorationIds) {
					accessor.removeDecoration(id);
				}
			});
			this._decorationIds = [];
		}
	}

	private _getGlyphMarginClassName(severity: 'error' | 'warning'): string {
		switch (severity) {
			case 'error':
				return 'error-detection-glyph-error';
			case 'warning':
				return 'error-detection-glyph-warning';
			default:
				return 'error-detection-glyph-info';
		}
	}

	private _createHoverContent(error: DetectedError, uri: URI): { content: MarkdownString } {
		const parts: string[] = [];

		// Title with severity
		parts.push(`**${error.severity.toUpperCase()}**: ${error.message}`);

		// Code if available
		if (error.code) {
			parts.push(`\n*Code: ${error.code}*`);
		}

		// Source if available
		if (error.source) {
			parts.push(`\n*Source: ${error.source}*`);
		}

		// Available fixes
		if (error.quickFixes && error.quickFixes.length > 0) {
			parts.push(`\n\n**Available Fixes:**`);
			for (const fix of error.quickFixes) {
				parts.push(`- ${fix.title}`);
			}
			parts.push(`\n\n*Right-click to apply fix*`);
		}

		const markdown = new MarkdownString(parts.join('\n'), true);
		markdown.isTrusted = true;

		return { content: markdown };
	}
}

registerEditorContribution(ErrorDetectionEditorContribution.ID, ErrorDetectionEditorContribution, EditorContributionInstantiation.Lazy);

