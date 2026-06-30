/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * AI provenance editor contribution (roadmap §L1179).
 *
 * Decorates every block opened by an `@ai-generated <model> <ts>` marker
 * with an overview-ruler band, a linesDecorations gutter strip, and a
 * hover that names the model and timestamp. Block end = next blank line
 * or next marker. Auto-refreshes on model swap and content change.
 *
 * Producer of the markers themselves is `formatProvenanceMarker` (see
 * `vibeAiProvenanceConfiguration.ts`). This file is read-only consumer.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { IModelDecorationOptions, OverviewRulerLane, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { Range } from '../../../../editor/common/core/range.js';
import { themeColorFromId } from '../../../../platform/theme/common/themeService.js';
import { editorInfoForeground } from '../../../../platform/theme/common/colors/editorColors.js';
import { detectProvenanceBlocks, ProvenanceBlock, renderProvenanceHover } from '../common/aiProvenanceBlockDetector.js';

const DECORATION_OPTIONS_PROTO: Omit<IModelDecorationOptions, 'hoverMessage'> = {
	description: 'vibe-ai-provenance-block',
	isWholeLine: true,
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	linesDecorationsClassName: 'vibe-ai-provenance-gutter',
	overviewRuler: {
		color: themeColorFromId(editorInfoForeground),
		position: OverviewRulerLane.Right,
	},
};

export class VibeAiProvenanceEditorContribution extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.vibeAiProvenance';

	private _decorationIds: string[] = [];

	constructor(private readonly _editor: ICodeEditor) {
		super();
		this._register(this._editor.onDidChangeModel(() => this._refresh()));
		this._register(this._editor.onDidChangeModelContent(() => this._refresh()));
		this._refresh();
	}

	private _refresh(): void {
		const model = this._editor.getModel();
		if (!model) {
			this._clear();
			return;
		}
		const text = model.getValue();
		const lines = text.split(/\r\n|\r|\n/);
		const blocks = detectProvenanceBlocks(lines);
		if (blocks.length === 0) {
			this._clear();
			return;
		}
		const decorations = blocks.map(b => this._buildDecoration(b, model.getLineMaxColumn(b.blockEnd)));
		this._clear();
		this._decorationIds = model.deltaDecorations([], decorations);
	}

	private _buildDecoration(block: ProvenanceBlock, endCol: number): { range: Range; options: IModelDecorationOptions } {
		const range = new Range(block.markerLine, 1, block.blockEnd, endCol);
		const hover = new MarkdownString(renderProvenanceHover(block), true);
		hover.isTrusted = true;
		return {
			range,
			options: { ...DECORATION_OPTIONS_PROTO, hoverMessage: hover },
		};
	}

	private _clear(): void {
		const model = this._editor.getModel();
		if (model && this._decorationIds.length > 0) {
			this._decorationIds = model.deltaDecorations(this._decorationIds, []);
		} else {
			this._decorationIds = [];
		}
	}

	override dispose(): void {
		this._clear();
		super.dispose();
	}
}

registerEditorContribution(VibeAiProvenanceEditorContribution.ID, VibeAiProvenanceEditorContribution, EditorContributionInstantiation.Lazy);
