/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as DOM from '../../../../base/browser/dom.js';
import { extname } from '../../../../base/common/path.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
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
import { IHostService } from '../../../services/host/browser/host.js';
import { IFolderToOpen, IWorkspaceToOpen } from '../../../../platform/window/common/window.js';
import { IVibeProjectsEntry, IVibeProjectsService } from './vibeProjectsService.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isLinux } from '../../../../base/common/platform.js';

const $ = DOM.$;
const ROW_TEMPLATE = 'vibeProjects.row';

interface IRowTemplate {
	readonly primary: HTMLElement;
	readonly actionBar: ActionBar;
}

class VibeProjectsListDelegate implements IListVirtualDelegate<IVibeProjectsEntry> {
	getHeight(): number {
		return 22;
	}
	getTemplateId(): string {
		return ROW_TEMPLATE;
	}
}

class VibeProjectsListRenderer implements IListRenderer<IVibeProjectsEntry, IRowTemplate> {
	readonly templateId = ROW_TEMPLATE;

	constructor(
		private readonly _getActivePath: () => string | undefined,
		private readonly _onRename: (entry: IVibeProjectsEntry) => void,
		private readonly _onForget: (entry: IVibeProjectsEntry) => void,
	) { }

	renderTemplate(container: HTMLElement): IRowTemplate {
		const row = DOM.append(container, $('.vibe-projects-slot-row'));
		const primary = DOM.append(row, $('span.vibe-projects-slot-label'));
		const actions = DOM.append(row, $('.vibe-projects-slot-actions'));
		const actionBar = new ActionBar(actions);
		return { primary, actionBar };
	}

	renderElement(entry: IVibeProjectsEntry, _index: number, data: IRowTemplate): void {
		data.primary.textContent = entry.label;
		data.primary.title = entry.target.fsPath || entry.target.toString(true);
		// Per-row inline actions: pencil = rename, trash = remove from the list. Rebound each render
		// since the row template is recycled across entries (virtual list).
		data.actionBar.clear();
		data.actionBar.push([
			new Action('vibeProjects.row.rename', localize('vibeProjects.row.rename', "Переименовать"), ThemeIcon.asClassName(Codicon.edit), true, async () => this._onRename(entry)),
			new Action('vibeProjects.row.forget', localize('vibeProjects.row.forget', "Удалить из списка"), ThemeIcon.asClassName(Codicon.trash), true, async () => this._onForget(entry)),
		], { icon: true, label: false });
		const row = data.primary.parentElement;
		if (!row) {
			return;
		}
		const active = this._getActivePath();
		const candidate = normalizePath(entry.target.fsPath || entry.target.path);
		row.classList.toggle('active', !!active && candidate === active);
	}

	disposeTemplate(data: IRowTemplate): void {
		data.actionBar.dispose();
	}
}

function normalizePath(p: string): string {
	const folded = p.replace(/\\/g, '/').replace(/\/+$/, '');
	const stripped = (folded.length > 1 && folded[0] === '/' && /^\/[a-zA-Z]:/.test(folded))
		? folded.slice(1)
		: folded;
	return isLinux ? stripped : stripped.toLowerCase();
}

export class VibeProjectsViewPane extends ViewPane {

	private _list: WorkbenchList<IVibeProjectsEntry> | undefined;
	private _bodyDom: HTMLElement | undefined;
	/** When true, welcome panel is shown instead of the roster. */
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
		@IVibeProjectsService private readonly _registry: IVibeProjectsService,
		@IHostService private readonly _host: IHostService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.onDidChangeViewWelcomeState(() => this._syncRosterHostVisibility()));
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => void this._paint()));
	}

	private _activeWorkspacePath(): string | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		return normalizePath(folders[0].uri.fsPath);
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
		this._bodyDom = DOM.append(container, $('.vibe-projects-body'));
		this._syncRosterHostVisibility();
		const delegate = new VibeProjectsListDelegate();
		const renderer = new VibeProjectsListRenderer(
			() => this._activeWorkspacePath(),
			entry => void this._renameEntry(entry),
			entry => void this._registry.dropEntry(entry.id),
		);
		const listOptions: IWorkbenchListOptions<IVibeProjectsEntry> = {
			identityProvider: { getId: e => e.id },
			multipleSelectionSupport: false,
			openOnSingleClick: true,
			accessibilityProvider: this._accessibility(),
		};
		const list = this.instantiationService.createInstance(
			WorkbenchList,
			'VibeProjectsSlotRoster',
			this._bodyDom,
			delegate,
			[renderer],
			listOptions,
		) as WorkbenchList<IVibeProjectsEntry>;
		this._list = list;
		this._register(list);
		this._register(list.onDidOpen(e => {
			if (e.element) {
				void this._openTarget(e.element.target, false);
			}
		}));
		this._register(list.onContextMenu(e => {
			if (!e.element) {
				return;
			}
			const hit = e.element;
			this.contextMenuService.showContextMenu({
				getAnchor: () => e.anchor,
				getActions: () => this._ctxSlice(hit),
				getActionsContext: () => hit,
			});
		}));
		this._register(this._registry.onDidChangeEntries(() => this._paint()));
		void this._paint();
	}

	private _accessibility(): IListAccessibilityProvider<IVibeProjectsEntry> {
		return {
			getAriaLabel: e => e.label,
			getWidgetAriaLabel: () => localize('vibeProjects.aria.widget', "Закладки Vibe Projects"),
		};
	}

	private _ctxSlice(entry: IVibeProjectsEntry): IAction[] {
		return [
			new Action('vibeProjects.ctx.open', localize('vibeProjects.ctx.open', "Открыть"), '', true, () => void this._openTarget(entry.target, false)),
			new Action('vibeProjects.ctx.openNew', localize('vibeProjects.ctx.openNew', "Открыть в новом окне"), '', true, () => void this._openTarget(entry.target, true)),
			new Separator(),
			new Action('vibeProjects.ctx.rename', localize('vibeProjects.ctx.rename', "Переименовать"), '', true, () => void this._renameEntry(entry)),
			new Action('vibeProjects.ctx.forget', localize('vibeProjects.ctx.forget', "Удалить из списка"), '', true, () => void this._registry.dropEntry(entry.id)),
		];
	}

	/** Rename a saved project in place (preserves list order). Persists via replaceAll. */
	private async _renameEntry(entry: IVibeProjectsEntry): Promise<void> {
		const next = await this._quickInputService.input({
			title: localize('vibeProjects.rename.title', "Переименовать проект"),
			value: entry.label,
			validateInput: async v => (v.trim().length ? undefined : localize('vibeProjects.rename.empty', "Название не может быть пустым")),
		});
		const label = next?.trim();
		if (!label || label === entry.label) {
			return;
		}
		const rows = await this._registry.readEntries();
		if (!rows.some(e => e.id === entry.id)) {
			return;
		}
		await this._registry.replaceAll(rows.map(e => e.id === entry.id ? { ...e, label } : e));
	}

	private async _paint(): Promise<void> {
		const list = this._list;
		if (!list) {
			return;
		}
		const rows = await this._registry.readEntries();
		const nextEmpty = rows.length === 0;
		if (nextEmpty !== this._rosterEmpty) {
			this._rosterEmpty = nextEmpty;
			this._onDidChangeViewWelcomeState.fire();
		}
		this._syncRosterHostVisibility();
		list.splice(0, list.length, rows);
		list.layout();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._list?.layout(height, width);
	}

	private async _openTarget(target: URI, forceNewWindow: boolean): Promise<void> {
		const payload = VibeProjectsViewPane._payloadFromUri(target);
		await this._host.openWindow([payload], { forceNewWindow });
	}

	private static _payloadFromUri(target: URI): IFolderToOpen | IWorkspaceToOpen {
		if (extname(target.fsPath) === '.code-workspace') {
			return { workspaceUri: target, label: target.fsPath };
		}
		return { folderUri: target, label: target.fsPath };
	}
}
