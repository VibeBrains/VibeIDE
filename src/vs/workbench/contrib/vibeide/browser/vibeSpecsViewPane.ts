/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as DOM from '../../../../base/browser/dom.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Action } from '../../../../base/common/actions.js';
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
import { WorkbenchList, IWorkbenchListOptions } from '../../../../platform/list/browser/listService.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { localize } from '../../../../nls.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibeSpecEntry, IVibeSpecsService } from './vibeSpecsService.js';

const $ = DOM.$;
const ROW_TEMPLATE = 'vibeSpecs.row';

interface IRowTemplate {
	readonly primary: HTMLElement;
	readonly badges: HTMLElement;
	readonly actionBar: ActionBar;
}

class VibeSpecsListDelegate implements IListVirtualDelegate<IVibeSpecEntry> {
	getHeight(): number {
		return 22;
	}
	getTemplateId(): string {
		return ROW_TEMPLATE;
	}
}

class VibeSpecsListRenderer implements IListRenderer<IVibeSpecEntry, IRowTemplate> {
	readonly templateId = ROW_TEMPLATE;

	constructor(
		private readonly _multiRoot: () => boolean,
		private readonly _onOpen: (uri: URI) => void,
	) { }

	renderTemplate(container: HTMLElement): IRowTemplate {
		const row = DOM.append(container, $('.vibe-specs-row'));
		const primary = DOM.append(row, $('span.vibe-specs-label'));
		const badges = DOM.append(row, $('span.vibe-specs-badges'));
		const actions = DOM.append(row, $('.vibe-specs-actions'));
		const actionBar = new ActionBar(actions);
		return { primary, badges, actionBar };
	}

	renderElement(entry: IVibeSpecEntry, _index: number, data: IRowTemplate): void {
		data.primary.textContent = this._multiRoot() ? entry.id : entry.specId;
		data.primary.title = entry.dir.fsPath || entry.dir.toString(true);

		// Badges show which docs the spec already has; missing docs render dimmed.
		data.badges.textContent = '';
		data.badges.appendChild(badge('P', !!entry.product, localize('vibeSpecs.badge.product', "PRODUCT.md")));
		data.badges.appendChild(badge('T', !!entry.tech, localize('vibeSpecs.badge.tech', "TECH.md")));

		// Inline actions rebound each render (virtual list recycles the template across entries).
		data.actionBar.clear();
		if (entry.product) {
			data.actionBar.push(
				new Action('vibeSpecs.row.openProduct', localize('vibeSpecs.row.openProduct', "Открыть PRODUCT.md"), ThemeIcon.asClassName(Codicon.book), true, async () => this._onOpen(entry.product!)),
				{ icon: true, label: false },
			);
		}
		if (entry.tech) {
			data.actionBar.push(
				new Action('vibeSpecs.row.openTech', localize('vibeSpecs.row.openTech', "Открыть TECH.md"), ThemeIcon.asClassName(Codicon.gear), true, async () => this._onOpen(entry.tech!)),
				{ icon: true, label: false },
			);
		}
	}

	disposeTemplate(data: IRowTemplate): void {
		data.actionBar.dispose();
	}
}

function badge(text: string, present: boolean, title: string): HTMLElement {
	const el = $('span.vibe-specs-badge');
	el.textContent = text;
	el.title = title + (present ? '' : localize('vibeSpecs.badge.missing', " — отсутствует"));
	el.classList.toggle('present', present);
	return el;
}

export class VibeSpecsViewPane extends ViewPane {

	private _list: WorkbenchList<IVibeSpecEntry> | undefined;
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
		@IVibeSpecsService private readonly _specs: IVibeSpecsService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
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
		this._bodyDom = DOM.append(container, $('.vibe-specs-body'));
		this._syncRosterHostVisibility();

		const multiRoot = () => this._workspaceContextService.getWorkspace().folders.length > 1;
		const delegate = new VibeSpecsListDelegate();
		const renderer = new VibeSpecsListRenderer(multiRoot, uri => void this._open(uri));
		const listOptions: IWorkbenchListOptions<IVibeSpecEntry> = {
			identityProvider: { getId: e => e.id },
			multipleSelectionSupport: false,
			openOnSingleClick: true,
			accessibilityProvider: this._accessibility(),
		};
		const list = this.instantiationService.createInstance(
			WorkbenchList,
			'VibeSpecsList',
			this._bodyDom,
			delegate,
			[renderer],
			listOptions,
		) as WorkbenchList<IVibeSpecEntry>;
		this._list = list;
		this._register(list);
		// Single-click opens PRODUCT.md, falling back to TECH.md for tech-only specs.
		this._register(list.onDidOpen(e => {
			const hit = e.element;
			if (hit) {
				void this._open(hit.product ?? hit.tech);
			}
		}));
		this._register(this._specs.onDidChangeSpecs(() => this._paint()));
		void this._paint();
	}

	private _accessibility(): IListAccessibilityProvider<IVibeSpecEntry> {
		return {
			getAriaLabel: e => e.id,
			getWidgetAriaLabel: () => localize('vibeSpecs.aria.widget', "Спеки проекта"),
		};
	}

	private async _paint(): Promise<void> {
		const list = this._list;
		if (!list) {
			return;
		}
		const rows = await this._specs.readSpecs();
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

	private async _open(uri: URI | undefined): Promise<void> {
		if (!uri) {
			return;
		}
		await this._editorService.openEditor({ resource: uri, options: { pinned: false } });
	}
}
