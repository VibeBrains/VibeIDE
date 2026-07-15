/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Local graph of the active doc, in the sidebar. The full graph in a 300px-wide pane is a hairball,
 * so this shows only the neighbourhood — which is also the question you actually have while reading
 * a doc: what does this connect to?
 */

import * as DOM from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { localGraph } from '../common/vibeDocsGraph.js';
import { VibeDocsGraphCanvas } from './vibeDocsGraphCanvas.js';
import { IVibeDocsGraphService } from './vibeDocsGraphService.js';
import { VIBE_DOCS_GRAPH_LOCAL_DEPTH } from './vibeDocsConstants.js';

const $ = DOM.$;

/** Contributed by `markdown-language-features` — the same command the docs tree opens rows with. */
const MARKDOWN_SHOW_PREVIEW_CMD = 'markdown.showPreview';

export class VibeDocsGraphViewPane extends ViewPane {

	private _canvas: VibeDocsGraphCanvas | undefined;
	private _host: HTMLElement | undefined;
	private _empty: HTMLElement | undefined;
	private _activeId: string | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IVibeDocsGraphService private readonly _graphService: IVibeDocsGraphService,
		@IEditorService private readonly _editorService: IEditorService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._host = DOM.append(container, $('.vibe-docs-graph-view'));
		this._empty = DOM.append(this._host, $('.vibe-docs-graph-empty'));
		this._empty.textContent = localize('vibeDocsGraph.view.empty', "Откройте документ, чтобы увидеть его связи.");

		this._canvas = this._register(this.instantiationService.createInstance(VibeDocsGraphCanvas, this._host, {
			onOpen: (id: string) => this._open(id),
		}));

		// Docs opened from anywhere else (the Explorer, Quick Open) still arrive as real file
		// editors, so feed those to the service too; it ignores everything that isn't a doc.
		this._register(this._editorService.onDidActiveEditorChange(() => {
			this._graphService.setActiveDoc(this._editorService.activeEditor?.resource);
		}));
		this._register(this._graphService.onDidChangeActiveDoc(() => void this._sync()));
		this._register(this._graphService.onDidChangeGraph(() => void this._sync()));
		void this._sync();
	}

	private async _sync(): Promise<void> {
		const id = this._graphService.activeDocId;
		this._activeId = id;

		const showEmpty = !id;
		if (this._empty) {
			this._empty.style.display = showEmpty ? '' : 'none';
		}
		if (showEmpty || !this._canvas) {
			return;
		}
		const graph = await this._graphService.readGraph();
		// The active editor may have moved on while we were reading the corpus.
		if (this._activeId !== id) {
			return;
		}
		// setGraph fits the neighbourhood into the pane once the layout settles.
		this._canvas.setGraph(localGraph(graph, id, VIBE_DOCS_GRAPH_LOCAL_DEPTH));
		this._canvas.setFocus(id);
	}

	/** Same gesture, same result as clicking the row in the docs tree: the doc, rendered. */
	private async _open(id: string): Promise<void> {
		const uri: URI | undefined = this._graphService.uriOf(id);
		if (uri) {
			this._graphService.setActiveDoc(uri);
			await this._commandService.executeCommand(MARKDOWN_SHOW_PREVIEW_CMD, uri);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._canvas?.layout(width, height);
	}
}
