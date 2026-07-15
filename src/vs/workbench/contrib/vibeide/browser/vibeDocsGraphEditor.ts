/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The full docs graph as an editor tab — the same shape Obsidian gives it. A tab is resizable,
 * splits against the doc it describes and survives a restart, none of which a modal does.
 */

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import {
	EditorExtensions,
	IEditorSerializer,
	IEditorFactoryRegistry,
	IEditorOpenContext,
} from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IDocGraph } from '../common/vibeDocsGraph.js';
import { VibeDocsGraphCanvas } from './vibeDocsGraphCanvas.js';
import { IVibeDocsGraphService } from './vibeDocsGraphService.js';

const $ = DOM.$;

/** Contributed by `markdown-language-features` — the same command the docs tree opens rows with. */
const MARKDOWN_SHOW_PREVIEW_CMD = 'markdown.showPreview';

export class VibeDocsGraphInput extends EditorInput {
	static readonly ID = 'workbench.input.vibeDocsGraph';
	static readonly RESOURCE = URI.from({ scheme: 'vibe-docs-graph', path: 'graph' });

	readonly resource = VibeDocsGraphInput.RESOURCE;

	override get typeId(): string {
		return VibeDocsGraphInput.ID;
	}

	override getName(): string {
		return localize('vibeDocsGraph.tab', "Граф документов");
	}

	override getIcon(): ThemeIcon {
		return Codicon.typeHierarchy;
	}
}

export class VibeDocsGraphPane extends EditorPane {
	static readonly ID = 'workbench.editor.vibeDocsGraph';

	private _canvas: VibeDocsGraphCanvas | undefined;
	private _host: HTMLElement | undefined;
	private _canvasHost: HTMLElement | undefined;
	private _status: HTMLElement | undefined;
	private _pendingReveal: string | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IVibeDocsGraphService private readonly _graphService: IVibeDocsGraphService,
		@ICommandService private readonly _commandService: ICommandService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
	) {
		super(VibeDocsGraphPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._host = DOM.append(parent, $('.vibe-docs-graph-editor'));
		const toolbar = DOM.append(this._host, $('.vibe-docs-graph-toolbar'));
		this._canvasHost = DOM.append(this._host, $('.vibe-docs-graph-host'));

		const search = this._register(new InputBox(DOM.append(toolbar, $('.vibe-docs-graph-search')), this._contextViewService, {
			inputBoxStyles: defaultInputBoxStyles,
			placeholder: localize('vibeDocsGraph.search', "Поиск по имени…"),
			ariaLabel: localize('vibeDocsGraph.search.aria', "Поиск документа в графе"),
		}));
		this._register(search.onDidChange(value => this._canvas?.setSearch(value)));

		const reset = DOM.append(toolbar, $('a.vibe-docs-graph-reset'));
		reset.textContent = localize('vibeDocsGraph.reset', "Вписать в экран");
		reset.tabIndex = 0;
		this._register(DOM.addDisposableListener(reset, DOM.EventType.CLICK, () => this._canvas?.resetView()));

		this._status = DOM.append(toolbar, $('span.vibe-docs-graph-status'));

		this._canvas = this._register(this._instantiationService.createInstance(VibeDocsGraphCanvas, this._canvasHost, {
			onOpen: (id: string) => this._open(id),
		}));

		this._register(this._graphService.onDidChangeGraph(() => void this._refresh()));
	}

	override async setInput(input: VibeDocsGraphInput, options: unknown, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options as never, context, token);
		await this._refresh();
	}

	private async _refresh(): Promise<void> {
		const graph = await this._graphService.readGraph();
		if (!this._canvas) {
			return;
		}
		this._canvas.setGraph(graph);
		this._renderStatus(graph);
		// setGraph fits the view once the layout settles; a pending reveal overrides that.
		if (this._pendingReveal) {
			this._canvas.revealWhenSettled(this._pendingReveal);
			this._pendingReveal = undefined;
		}
	}

	/**
	 * Called straight off `openEditor`'s returned pane, which may resolve before the corpus has
	 * been read. If the node isn't there yet the request is held for the refresh that follows.
	 */
	reveal(id: string): void {
		if (this._canvas?.hasNode(id)) {
			this._canvas.revealWhenSettled(id);
			return;
		}
		this._pendingReveal = id;
	}

	/** The numbers the gate reports, where you can see them while looking at the shape. */
	private _renderStatus(graph: IDocGraph): void {
		if (!this._status) {
			return;
		}
		const unreachable = graph.nodes.filter(n => !n.reachable).length;
		this._status.textContent = localize(
			'vibeDocsGraph.status',
			"{0} документов · {1} связей · {2} недостижимых · {3} битых ссылок",
			graph.nodes.length, graph.edges.length, unreachable, graph.deadLinks.length,
		);
	}

	/** Same gesture, same result as clicking the row in the docs tree: the doc, rendered. */
	private async _open(id: string): Promise<void> {
		const uri = this._graphService.uriOf(id);
		if (uri) {
			this._graphService.setActiveDoc(uri);
			await this._commandService.executeCommand(MARKDOWN_SHOW_PREVIEW_CMD, uri);
		}
	}

	override layout(dimension: Dimension): void {
		if (!this._host || !this._canvasHost) {
			return;
		}
		this._host.style.width = `${dimension.width}px`;
		this._host.style.height = `${dimension.height}px`;
		// The canvas gets whatever the toolbar leaves — it is measured, not guessed, so a
		// localized toolbar that wraps to two lines can't crop the graph.
		const toolbarHeight = this._canvasHost.offsetTop;
		this._canvas?.layout(dimension.width, Math.max(0, dimension.height - toolbarHeight));
	}

	override focus(): void {
		super.focus();
		this._canvasHost?.focus();
	}

}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibeDocsGraphPane, VibeDocsGraphPane.ID, localize('vibeDocsGraph.paneName', "Граф документов")),
	[new SyncDescriptor(VibeDocsGraphInput)],
);

/**
 * The tab carries no state of its own — the graph is rebuilt from disk — so restoring it is just
 * re-creating the input. That is what lets the tab survive a restart.
 */
class VibeDocsGraphInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(VibeDocsGraphInput);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(VibeDocsGraphInput.ID, VibeDocsGraphInputSerializer);

export const VIBE_DOCS_GRAPH_OPEN_TITLE = localize2('vibeDocsGraph.open', 'Документы: Граф документов');
