/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as DOM from '../../../../base/browser/dom.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { IHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../../../platform/hover/browser/hover.js';
import { WorkbenchList, IWorkbenchListOptions } from '../../../../platform/list/browser/listService.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { localize } from '../../../../nls.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibeSpecEntry, IVibeSpecsService, VibeSpecStatus } from './vibeSpecsService.js';
import { IChatThreadService } from './chatThreadService.js';
import { VIBEIDE_VIEW_CONTAINER_ID } from './sidebarPane.js';
import { VIBE_SPECS_TECH_FILE } from './vibeSpecsConstants.js';

const $ = DOM.$;
const ROW_TEMPLATE = 'vibeSpecs.row';

/** Row action callbacks, wired by the pane. */
interface IRowActions {
	readonly multiRoot: () => boolean;
	readonly open: (uri: URI) => void;
	readonly createTech: (entry: IVibeSpecEntry) => void;
	/** Attach a managed, 1s-delayed hover to a pill; returns the handle so its content can be updated. */
	readonly hover: (el: HTMLElement) => IManagedHover;
}

interface IRowTemplate {
	readonly label: HTMLElement;
	readonly s: HTMLElement;
	readonly p: HTMLElement;
	readonly t: HTMLElement;
	readonly sHover: IManagedHover;
	readonly pHover: IManagedHover;
	readonly tHover: IManagedHover;
	/** Current row's entry, read by the persistent P/T click listeners. */
	readonly ctx: { entry?: IVibeSpecEntry };
	readonly disposables: DisposableStore;
}

class VibeSpecsListDelegate implements IListVirtualDelegate<IVibeSpecEntry> {
	getHeight(): number {
		return 22; // single line: name + [S][P][T] pills
	}
	getTemplateId(): string {
		return ROW_TEMPLATE;
	}
}

const STATUS_LABEL: Record<VibeSpecStatus, string> = {
	draft: localize('vibeSpecs.status.draft', "черновик"),
	approved: localize('vibeSpecs.status.approved', "утверждена"),
	implemented: localize('vibeSpecs.status.implemented', "реализована"),
};

class VibeSpecsListRenderer implements IListRenderer<IVibeSpecEntry, IRowTemplate> {
	readonly templateId = ROW_TEMPLATE;

	constructor(private readonly _actions: IRowActions) { }

	renderTemplate(container: HTMLElement): IRowTemplate {
		const disposables = new DisposableStore();
		const ctx: { entry?: IVibeSpecEntry } = {};
		const row = DOM.append(container, $('.vibe-specs-row'));
		const label = DOM.append(row, $('span.vibe-specs-label'));
		const badges = DOM.append(row, $('span.vibe-specs-badges'));

		// P/T/S pills created ONCE (fixed-width → aligned, no «ladder»); content/state updated per render.
		// Order: P = PRODUCT.md, T = TECH.md, then S = status (colour-coded) last. Managed 1s hovers explain each.
		const p = DOM.append(badges, $('span.vibe-specs-badge'));
		p.textContent = 'P';
		const t = DOM.append(badges, $('span.vibe-specs-badge'));
		t.textContent = 'T';
		const s = DOM.append(badges, $('span.vibe-specs-badge'));
		s.textContent = 'S';

		// P/T click → open/create; stopPropagation so it doesn't also trigger the list row's open.
		const bindClick = (el: HTMLElement, run: (e: IVibeSpecEntry) => void) => {
			disposables.add(DOM.addDisposableListener(el, 'mousedown', e => e.stopPropagation()));
			disposables.add(DOM.addDisposableListener(el, 'click', e => {
				e.stopPropagation();
				if (ctx.entry) { run(ctx.entry); }
			}));
		};
		bindClick(p, e => { if (e.product) { this._actions.open(e.product); } });
		bindClick(t, e => { if (e.tech) { this._actions.open(e.tech); } else { this._actions.createTech(e); } });

		const sHover = this._actions.hover(s);
		const pHover = this._actions.hover(p);
		const tHover = this._actions.hover(t);
		disposables.add(sHover); disposables.add(pHover); disposables.add(tHover);

		return { label, s, p, t, sHover, pHover, tHover, ctx, disposables };
	}

	renderElement(entry: IVibeSpecEntry, _index: number, data: IRowTemplate): void {
		data.ctx.entry = entry;
		data.label.textContent = this._actions.multiRoot() ? entry.id : entry.specId;
		data.label.title = entry.dir.fsPath || entry.dir.toString(true);

		// S — colour-coded status pill (no text label; colour + hover carry the meaning).
		data.s.className = 'vibe-specs-badge vibe-specs-badge-s' + (entry.status ? ` status-${entry.status}` : ' status-unknown');
		data.sHover.update(entry.status
			? localize('vibeSpecs.hover.status', "Статус: {0}", STATUS_LABEL[entry.status])
			: localize('vibeSpecs.hover.statusNone', "Статус не задан (нет `status:` во фронтматтере)"));

		// P — PRODUCT.md: present = filled + opens; absent = dim.
		data.p.className = 'vibe-specs-badge' + (entry.product ? ' present clickable' : '');
		data.pHover.update(entry.product
			? localize('vibeSpecs.hover.openProduct', "Открыть PRODUCT.md (поведение)")
			: localize('vibeSpecs.hover.noProduct', "PRODUCT.md отсутствует"));

		// T — TECH.md: present = filled + opens; absent = dashed «click to create».
		data.t.className = 'vibe-specs-badge clickable' + (entry.tech ? ' present' : ' create');
		data.tHover.update(entry.tech
			? localize('vibeSpecs.hover.openTech', "Открыть TECH.md (реализация)")
			: localize('vibeSpecs.hover.createTech', "Создать TECH.md"));
	}

	disposeTemplate(data: IRowTemplate): void {
		data.disposables.dispose();
	}
}

/** Minimal TECH.md seed; write-tech-spec fills the real plan. Skeleton lives in the skill's references/. */
const TECH_SEED = (specId: string) => [
	`# ${specId} — техническая спека`,
	'',
	'## Context',
	'',
	'<Что меняем, как область работает сейчас, ключевые файлы со ссылками на строки.>',
	'',
	'Пользовательское поведение — см. `PRODUCT.md`.',
	'',
	'## Proposed changes',
	'',
	'- <Модуль/файл: что меняется и почему так.>',
	'',
	'## Testing and validation',
	'',
	'- PRODUCT.md #<N> → <тест или шаг проверки.>',
	'',
].join('\n');

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
		@IHoverService private readonly _hoverService: IHoverService,
		@IVibeSpecsService private readonly _specs: IVibeSpecsService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IDialogService private readonly _dialogService: IDialogService,
		@ICommandService private readonly _commandService: ICommandService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IViewsService private readonly _viewsService: IViewsService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, _hoverService);
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

		// 1-second delayed hovers for the S/P/T pills (guideline: use IHoverService, not native title).
		const hoverDelegate = this._register(this.instantiationService.createInstance(WorkbenchHoverDelegate, 'element', { dynamicDelay: () => 1000 }, {})) as IHoverDelegate;
		const delegate = new VibeSpecsListDelegate();
		const renderer = new VibeSpecsListRenderer({
			multiRoot: () => this._workspaceContextService.getWorkspace().folders.length > 1,
			open: uri => void this._open(uri),
			createTech: entry => void this._createTech(entry),
			hover: el => this._hoverService.setupManagedHover(hoverDelegate, el, ''),
		});
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
		this._register(list.onContextMenu(e => {
			if (!e.element) {
				return;
			}
			const hit = e.element;
			this.contextMenuService.showContextMenu({
				getAnchor: () => e.anchor,
				getActions: () => this._ctxActions(hit),
				getActionsContext: () => hit,
			});
		}));
		this._register(this._specs.onDidChangeSpecs(() => this._paint()));
		void this._paint();
	}

	private _accessibility(): IListAccessibilityProvider<IVibeSpecEntry> {
		return {
			getAriaLabel: e => e.status ? `${e.id} — ${STATUS_LABEL[e.status]}` : e.id,
			getWidgetAriaLabel: () => localize('vibeSpecs.aria.widget', "Спеки проекта"),
		};
	}

	private _ctxActions(entry: IVibeSpecEntry): IAction[] {
		const actions: IAction[] = [];
		if (entry.product) {
			actions.push(new Action('vibeSpecs.ctx.openProduct', localize('vibeSpecs.ctx.openProduct', "Открыть PRODUCT.md"), '', true, () => void this._open(entry.product)));
		}
		if (entry.tech) {
			actions.push(new Action('vibeSpecs.ctx.openTech', localize('vibeSpecs.ctx.openTech', "Открыть TECH.md"), '', true, () => void this._open(entry.tech)));
		} else {
			actions.push(new Action('vibeSpecs.ctx.createTech', localize('vibeSpecs.ctx.createTech', "Создать TECH.md"), '', true, () => void this._createTech(entry)));
		}
		if (entry.status === 'approved') {
			actions.push(new Separator());
			actions.push(new Action('vibeSpecs.ctx.implement', localize('vibeSpecs.ctx.implement', "Реализовать спеку"), '', true, () => void this._implementSpec(entry)));
		}
		actions.push(new Separator());
		actions.push(new Action('vibeSpecs.ctx.reveal', localize('vibeSpecs.ctx.reveal', "Показать в проводнике"), '', true, () => void this._commandService.executeCommand('revealInExplorer', entry.product ?? entry.tech ?? entry.dir)));
		actions.push(new Action('vibeSpecs.ctx.delete', localize('vibeSpecs.ctx.delete', "Удалить спеку"), '', true, () => void this._deleteSpec(entry)));
		return actions;
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

	private async _createTech(entry: IVibeSpecEntry): Promise<void> {
		const techUri = joinPath(entry.dir, VIBE_SPECS_TECH_FILE);
		if (await this._fileService.exists(techUri)) {
			await this._open(techUri);
			return;
		}
		await this._fileService.writeFile(techUri, VSBuffer.fromString(TECH_SEED(entry.specId)));
		this._specs.refresh();
		await this._open(techUri);
	}

	private async _implementSpec(entry: IVibeSpecEntry): Promise<void> {
		// Open chat, ensure a thread, bind the spec to it, then hand implementation to the agent.
		// The binding (boundThreadId in PRODUCT.md) is what arms spec-drift for this thread.
		await this._viewsService.openViewContainer(VIBEIDE_VIEW_CONTAINER_ID);
		let threadId = this._chatThreadService.state.currentThreadId;
		if (!threadId) {
			this._chatThreadService.openNewThread();
			threadId = this._chatThreadService.state.currentThreadId;
		}
		if (!threadId) {
			this._notificationService.info(localize('vibeSpecs.implement.noThread', "Не удалось открыть чат для реализации спеки."));
			return;
		}
		await this._specs.bindThreadToSpec(entry, threadId);
		const request = localize(
			'vibeSpecs.implement.request',
			"Реализуй спеку «{0}» по скиллу implement-specs: сначала прочитай её PRODUCT.md (и TECH.md, если есть) в каталоге спек, затем собери фичу по утверждённому поведению. Держись объявленной области `scope` из PRODUCT.md; правки вне неё требуют явного согласования. По завершении и проверке — выстави `status: implemented`.",
			entry.specId,
		);
		await this._chatThreadService.addUserMessageAndStreamResponse({ userMessage: request, threadId });
	}

	private async _deleteSpec(entry: IVibeSpecEntry): Promise<void> {
		const confirmed = await this._dialogService.confirm({
			type: 'warning',
			message: localize('vibeSpecs.delete.confirm', "Удалить спеку «{0}» вместе со всеми документами?", entry.specId),
			detail: entry.dir.fsPath,
			primaryButton: localize('vibeSpecs.delete.yes', "Удалить"),
		});
		if (!confirmed.confirmed) {
			return;
		}
		await this._fileService.del(entry.dir, { recursive: true, useTrash: true });
		this._specs.refresh();
	}
}
