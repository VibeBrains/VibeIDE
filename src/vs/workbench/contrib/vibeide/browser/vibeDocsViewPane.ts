/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as DOM from '../../../../base/browser/dom.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ITreeNode, IObjectTreeElement, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { localize } from '../../../../nls.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVibeDocNode, IVibeDocsService } from './vibeDocsService.js';

const $ = DOM.$;
const ROW_TEMPLATE = 'vibeDocs.row';

interface IRowTemplate {
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
}

class VibeDocsDelegate implements IListVirtualDelegate<IVibeDocNode> {
	getHeight(): number {
		return 22;
	}
	getTemplateId(): string {
		return ROW_TEMPLATE;
	}
}

class VibeDocsRenderer implements ITreeRenderer<IVibeDocNode, void, IRowTemplate> {
	readonly templateId = ROW_TEMPLATE;

	renderTemplate(container: HTMLElement): IRowTemplate {
		const row = DOM.append(container, $('.vibe-docs-row'));
		const icon = DOM.append(row, $('span.vibe-docs-icon'));
		const label = DOM.append(row, $('span.vibe-docs-label'));
		return { icon, label };
	}

	renderElement(node: ITreeNode<IVibeDocNode, void>, _index: number, data: IRowTemplate): void {
		const el = node.element;
		data.icon.className = 'vibe-docs-icon ' + ThemeIcon.asClassName(el.isDirectory ? Codicon.folder : Codicon.markdown);
		data.label.textContent = el.name;
		data.label.title = el.uri.fsPath || el.uri.toString(true);
	}

	disposeTemplate(): void { }
}

export class VibeDocsViewPane extends ViewPane {

	private _tree: WorkbenchObjectTree<IVibeDocNode, void> | undefined;
	private _bodyDom: HTMLElement | undefined;
	private _rosterEmpty = true;

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
		@IVibeDocsService private readonly _docs: IVibeDocsService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.onDidChangeViewWelcomeState(() => this._syncRosterHostVisibility()));
	}

	override shouldShowWelcome(): boolean {
		return this._rosterEmpty;
	}

	private _syncRosterHostVisibility(): void {
		if (this._bodyDom) {
			this._bodyDom.style.display = this.shouldShowWelcome() ? 'none' : '';
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._bodyDom = DOM.append(container, $('.vibe-docs-body'));
		this._syncRosterHostVisibility();

		const tree = this.instantiationService.createInstance(
			WorkbenchObjectTree,
			'VibeDocsTree',
			this._bodyDom,
			new VibeDocsDelegate(),
			[new VibeDocsRenderer()],
			{
				identityProvider: { getId: (e: IVibeDocNode) => e.id },
				accessibilityProvider: this._accessibility(),
				collapseByDefault: false,
			},
		) as WorkbenchObjectTree<IVibeDocNode, void>;
		this._tree = tree;
		this._register(tree);
		// Single-click opens a file; folders toggle (default tree behavior).
		this._register(tree.onDidOpen(e => {
			if (e.element && !e.element.isDirectory) {
				void this._open(e.element.uri);
			}
		}));
		this._register(this._docs.onDidChangeDocs(() => this._paint()));
		void this._paint();
	}

	private _accessibility(): IListAccessibilityProvider<IVibeDocNode> {
		return {
			getAriaLabel: e => e.relPath,
			getWidgetAriaLabel: () => localize('vibeDocs.aria.widget', "Документы проекта"),
		};
	}

	private _toElements(nodes: readonly IVibeDocNode[]): IObjectTreeElement<IVibeDocNode>[] {
		return nodes.map(n => ({
			element: n,
			children: n.isDirectory ? this._toElements(n.children) : undefined,
			collapsible: n.isDirectory,
		}));
	}

	private async _paint(): Promise<void> {
		const tree = this._tree;
		if (!tree) {
			return;
		}
		const nodes = await this._docs.readDocs();
		const nextEmpty = nodes.length === 0;
		if (nextEmpty !== this._rosterEmpty) {
			this._rosterEmpty = nextEmpty;
			this._onDidChangeViewWelcomeState.fire();
		}
		this._syncRosterHostVisibility();
		tree.setChildren(null, this._toElements(nodes));
		tree.layout();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._tree?.layout(height, width);
	}

	private async _open(uri: URI): Promise<void> {
		await this._editorService.openEditor({ resource: uri, options: { pinned: false } });
	}
}
