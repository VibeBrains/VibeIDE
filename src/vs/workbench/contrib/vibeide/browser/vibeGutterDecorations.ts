/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IVibeGutterIndicatorService } from './vibeGutterIndicatorService.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { IModelDeltaDecoration, TrackedRangeStickiness, OverviewRulerLane } from '../../../../editor/common/model.js';

// Color for agent-written lines in gutter (different from git diff blue/green/red)
const AGENT_WRITTEN_CLASS = 'vibeide-agent-written-gutter';

/**
 * VibeIDE Gutter Indicators.
 * Visually marks lines written by agent in current session.
 * Different color from standard git diff (git = green/red, agent = purple).
 */
export class VibeGutterDecorationsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeGutterDecorations';

	private static readonly DECORATION_OPTIONS = ModelDecorationOptions.register({
		description: 'vibeide-agent-written',
		glyphMarginClassName: AGENT_WRITTEN_CLASS,
		glyphMarginHoverMessage: {
			value: '🤖 Written by VibeIDE Agent in current session',
			isTrusted: true,
		},
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		overviewRuler: {
			color: { id: 'vibeide.agentWrittenLine' },
			position: OverviewRulerLane.Left,
		},
	});

	constructor(
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IVibeGutterIndicatorService private readonly _gutterService: IVibeGutterIndicatorService,
	) {
		super();
		this._setupCSS();
		this._registerListeners();
	}

	private _setupCSS(): void {
		// createStyleSheet appends to mainWindow.document.head and tracks the
		// stylesheet so auxiliary windows clone it; disposal removes it cleanly.
		createStyleSheet(undefined, style => {
			style.id = 'vibeide-gutter-decorations';
			style.textContent = `
				.${AGENT_WRITTEN_CLASS} {
					background: linear-gradient(to right, #f92aad, transparent);
					width: 3px !important;
					margin-left: 2px;
					border-radius: 1px;
				}
			`;
		}, this._store);
	}

	private _registerListeners(): void {
		// Update decorations when agent writes
		this._register(this._gutterService.onDidRecordAgentWrite(() => {
			this._updateDecorations();
		}));

		// Update when active editor changes
		this._register(this._codeEditorService.onCodeEditorAdd(() => {
			this._updateDecorations();
		}));
	}

	private _updateDecorations(): void {
		for (const editor of this._codeEditorService.listCodeEditors()) {
			const model = editor.getModel();
			if (!model) { continue; }

			const filePath = model.uri.fsPath;
			const ranges = this._gutterService.getAgentRanges(filePath);
			if (ranges.length === 0) { continue; }

			const decorations: IModelDeltaDecoration[] = ranges.map(r => ({
				range: {
					startLineNumber: r.startLine,
					startColumn: 1,
					endLineNumber: r.endLine,
					endColumn: 1,
				},
				options: VibeGutterDecorationsContribution.DECORATION_OPTIONS,
			}));

			editor.deltaDecorations([], decorations);
		}
	}
}

registerWorkbenchContribution2(
	VibeGutterDecorationsContribution.ID,
	VibeGutterDecorationsContribution,
	WorkbenchPhase.AfterRestored
);
