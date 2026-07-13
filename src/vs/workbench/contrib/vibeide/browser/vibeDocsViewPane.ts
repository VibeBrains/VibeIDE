/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as DOM from '../../../../base/browser/dom.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
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
import { WorkbenchList, IWorkbenchListOptions } from '../../../../platform/list/browser/listService.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { localize } from '../../../../nls.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVibeDocEntry, IVibeDocsService } from './vibeDocsService.js';

const $ = DOM.$;
const ROW_TEMPLATE = 'vibeDocs.row';

interface IRowTemplate {
	readonly label: HTMLElement;
}

class VibeDocsListDelegate implements IListVirtualDelegate<IVibeDocEntry> {
	getHeight(): number {
		return 22;
	}
	getTemplateId(): string {
		return ROW_TEMPLATE;
	}
}

class VibeDocsListRenderer implements IListRenderer<IVibeDocEntry, IRowTemplate> {
	readonly templateId = ROW_TEMPLATE;

	renderTemplate(container: HTMLElement): IRowTemplate {
		const row = DOM.append(container, $('.vibe-docs-row'));
		const label = DOM.append(row, $('span.vibe-docs-label'));
		return { label };
	}

	renderElement(entry: IVibeDocEntry, _index: number, data: IRowTemplate): void {
		data.label.textContent = entry.relPath;
		data.label.title = entry.uri.fsPath || entry.uri.toString(true);
	}

	disposeTemplate(): void { }
}

export class VibeDocsViewPane extends ViewPane {

	private _list: WorkbenchList<IVibeDocEntry> | undefined;
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

		const delegate = new VibeDocsListDelegate();
		const renderer = new VibeDocsListRenderer();
		const listOptions: IWorkbenchListOptions<IVibeDocEntry> = {
			identityProvider: { getId: e => e.id },
			multipleSelectionSupport: false,
			openOnSingleClick: true,
			accessibilityProvider: this._accessibility(),
		};
		const list = this.instantiationService.createInstance(
			WorkbenchList,
			'VibeDocsList',
			this._bodyDom,
			delegate,
			[renderer],
			listOptions,
		) as WorkbenchList<IVibeDocEntry>;
		this._list = list;
		this._register(list);
		this._register(list.onDidOpen(e => {
			if (e.element) {
				void this._open(e.element.uri);
			}
		}));
		this._register(this._docs.onDidChangeDocs(() => this._paint()));
		void this._paint();
	}

	private _accessibility(): IListAccessibilityProvider<IVibeDocEntry> {
		return {
			getAriaLabel: e => e.relPath,
			getWidgetAriaLabel: () => localize('vibeDocs.aria.widget', "Документы проекта"),
		};
	}

	private async _paint(): Promise<void> {
		const list = this._list;
		if (!list) {
			return;
		}
		const rows = await this._docs.readDocs();
		const nextEmpty = rows.length === 0;
		if (nextEmpty !== this._rosterEmpty) {
			this._rosterEmpty = nextEmpty;
			this._onDidChangeViewWelcomeState.fire();
		}
		this._syncRosterHostVisibility();
		list.splice(0, list.length, [...rows]);
		list.layout();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._list?.layout(height, width);
	}

	private async _open(uri: URI): Promise<void> {
		await this._editorService.openEditor({ resource: uri, options: { pinned: false } });
	}
}
