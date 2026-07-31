/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as DOM from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../../../../platform/hover/browser/hover.js';
import { IHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ViewPane, IViewPaneOptions } from '../../../../browser/parts/views/viewPane.js';
import { IVibeServerService } from './vibeServerService.js';
import { IVibeServerStackService, IVibeServerStackEntry, VibeServerEntryState } from './vibeServerStackService.js';
import { VibeServerCommands } from './vibeServerConstants.js';

const $ = DOM.$;

/** Codicon + spin flag for each entry state, shown as the status glyph in a stack row. */
function iconForState(state: VibeServerEntryState): { icon: ThemeIcon; spin?: boolean } {
	switch (state) {
		case 'running': return { icon: Codicon.passFilled };
		case 'starting': return { icon: Codicon.loading, spin: true };
		case 'failed': return { icon: Codicon.error };
		case 'excluded': return { icon: Codicon.circleSlash };
		default: return { icon: Codicon.circleLargeOutline };
	}
}

interface IAction {
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	/** Separator before this row. */
	readonly group?: boolean;
}

export class VibeServerViewPane extends ViewPane {

	private _bodyDom: HTMLElement | undefined;
	private readonly _renderStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly _hoverDelegate: IHoverDelegate;

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
		@IVibeServerService private readonly _vibeServerService: IVibeServerService,
		@IVibeServerStackService private readonly _stackService: IVibeServerStackService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, _hoverService);
		// Delayed hovers for stack rows (guideline: IHoverService, not native title).
		this._hoverDelegate = this._register(instantiationService.createInstance(WorkbenchHoverDelegate, 'element', { dynamicDelay: () => 700 }, {}));
		this._register(this._vibeServerService.onDidChangeStatus(() => this._render()));
		this._register(this._stackService.onDidChangeStack(() => this._render()));
		// Discover `.vibe/servers.json` (if any) as soon as the pane exists.
		void this._stackService.reload();
	}

	override shouldShowWelcome(): boolean {
		return false;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._bodyDom = DOM.append(container, $('.vibe-server-body'));
		this._render();
	}

	private _render(): void {
		const body = this._bodyDom;
		if (!body) {
			return;
		}
		const store = new DisposableStore();
		this._renderStore.value = store;
		DOM.clearNode(body);

		// A project with `.vibe/servers.json` gets the multi-server list; otherwise the original
		// single auto-detected server UI (absent file = today's behaviour).
		if (this._stackService.available) {
			this._renderStack(body, store);
			return;
		}

		const status = this._vibeServerService.status;

		// Status line.
		const line = DOM.append(body, $('.vibe-server-status-line'));
		if (status.state === 'running' && status.started) {
			line.textContent = localize('vibeServer.body.running', "Запущен: {0}", status.started.url);
		} else if (status.state === 'starting') {
			line.textContent = localize('vibeServer.body.starting', "Запуск…");
		} else {
			line.textContent = localize('vibeServer.body.idle', "Локальный предпросмотр без деплоя.");
		}

		// Vertical, labelled action buttons.
		const list = DOM.append(body, $('.vibe-server-actions'));
		for (const action of this._actionsFor(status.state)) {
			if (action.group) {
				DOM.append(list, $('.vibe-server-action-sep'));
			}
			const row = DOM.append(list, $('.vibe-server-action-row'));
			const icon = DOM.append(row, $('span.vibe-server-action-icon'));
			icon.className = `vibe-server-action-icon ${ThemeIcon.asClassName(action.icon)}`;
			DOM.append(row, $('span.vibe-server-action-label')).textContent = action.label;
			store.add(DOM.addDisposableListener(row, 'click', () => void this._commandService.executeCommand(action.id)));
		}
	}

	/** Renders the `.vibe/servers.json` stack: one row per entry with status + start/stop. */
	private _renderStack(body: HTMLElement, store: DisposableStore): void {
		const entries = this._stackService.entries;
		const anyRunning = entries.some(e => e.state === 'running' || e.state === 'starting');

		const header = DOM.append(body, $('.vibe-server-stack-header'));
		DOM.append(header, $('span.vibe-server-stack-title')).textContent = localize('vibeServer.stack.title', "Стек проекта");
		const allBtn = DOM.append(header, $('span.vibe-server-stack-all'));
		allBtn.className = `vibe-server-stack-all ${ThemeIcon.asClassName(anyRunning ? Codicon.debugStop : Codicon.runAll)}`;
		const allLabel = anyRunning ? localize('vibeServer.stack.stopAll', "Остановить всё") : localize('vibeServer.stack.startAll', "Запустить всё");
		store.add(this._hoverService.setupManagedHover(this._hoverDelegate, allBtn, allLabel));
		store.add(DOM.addDisposableListener(allBtn, 'click', () => {
			void (anyRunning ? this._stackService.stopAll() : this._stackService.startAll());
		}));

		const list = DOM.append(body, $('.vibe-server-stack-list'));
		for (const item of entries) {
			this._renderStackRow(list, item, store);
		}

		for (const warning of this._stackService.warnings) {
			DOM.append(body, $('.vibe-server-stack-warning')).textContent = warning;
		}
	}

	private _renderStackRow(list: HTMLElement, item: IVibeServerStackEntry, store: DisposableStore): void {
		const running = item.state === 'running';
		const busy = item.state === 'starting';
		const row = DOM.append(list, $('.vibe-server-stack-row'));
		row.classList.toggle('excluded', item.state === 'excluded');

		const glyph = iconForState(item.state);
		const statusIcon = DOM.append(row, $('span.vibe-server-stack-status'));
		statusIcon.className = `vibe-server-stack-status ${ThemeIcon.asClassName(glyph.icon)}${glyph.spin ? ' codicon-modifier-spin' : ''}`;

		DOM.append(row, $('span.vibe-server-stack-name')).textContent = item.entry.name ?? item.entry.id;
		const meta = DOM.append(row, $('span.vibe-server-stack-port'));
		meta.textContent = typeof item.entry.port === 'number' ? `:${item.entry.port}` : '';

		// The detail (failure/exclusion reason) is the row's hover, so a silent-looking row still explains itself.
		if (item.detail) {
			store.add(this._hoverService.setupManagedHover(this._hoverDelegate, row, item.detail));
		}

		const action = DOM.append(row, $('span.vibe-server-stack-action'));
		const actionIcon = running || busy ? Codicon.debugStop : Codicon.play;
		action.className = `vibe-server-stack-action ${ThemeIcon.asClassName(actionIcon)}`;
		const actionLabel = running || busy ? localize('vibeServer.stack.stop', "Остановить") : localize('vibeServer.stack.start', "Запустить");
		store.add(this._hoverService.setupManagedHover(this._hoverDelegate, action, actionLabel));
		store.add(DOM.addDisposableListener(action, 'click', e => {
			e.stopPropagation();
			void (running || busy ? this._stackService.stopEntry(item.entry.id) : this._stackService.startEntry(item.entry.id));
		}));
	}

	private _actionsFor(state: IVibeServerService['status']['state']): IAction[] {
		if (state === 'running') {
			return [
				{ id: VibeServerCommands.openPreview, label: localize('vibeServer.act.open', "Открыть превью"), icon: Codicon.openPreview },
				{ id: VibeServerCommands.openPreviewNewTab, label: localize('vibeServer.act.newTab', "Новое превью (вкладка)"), icon: Codicon.splitHorizontal },
				{ id: VibeServerCommands.reloadPreview, label: localize('vibeServer.act.reload', "Обновить превью"), icon: Codicon.sync },
				{ id: VibeServerCommands.openExternal, label: localize('vibeServer.act.external', "Во внешнем браузере"), icon: Codicon.linkExternal },
				{ id: VibeServerCommands.copyUrl, label: localize('vibeServer.act.copy', "Копировать URL"), icon: Codicon.copy, group: true },
				{ id: VibeServerCommands.showLanQr, label: localize('vibeServer.act.qr', "QR для телефона"), icon: Codicon.deviceMobile },
				{ id: VibeServerCommands.showLanAddress, label: localize('vibeServer.act.lan', "Адрес в сети (LAN)"), icon: Codicon.broadcast },
				{ id: VibeServerCommands.previewErrorsToChat, label: localize('vibeServer.act.errors', "Ошибки превью в чат"), icon: Codicon.commentDiscussion },
				{ id: VibeServerCommands.restart, label: localize('vibeServer.act.restart', "Перезапустить"), icon: Codicon.refresh, group: true },
				{ id: VibeServerCommands.stop, label: localize('vibeServer.act.stop', "Остановить"), icon: Codicon.debugStop },
				{ id: VibeServerCommands.openSettings, label: localize('vibeServer.act.settings', "Настройки"), icon: Codicon.settingsGear, group: true },
			];
		}
		if (state === 'starting') {
			return [];
		}
		return [
			{ id: VibeServerCommands.start, label: localize('vibeServer.act.start', "Запустить"), icon: Codicon.play },
			{ id: VibeServerCommands.startEnvironment, label: localize('vibeServer.act.env', "Поднять окружение (Docker)"), icon: Codicon.package },
			{ id: VibeServerCommands.openSettings, label: localize('vibeServer.act.settings', "Настройки"), icon: Codicon.settingsGear, group: true },
		];
	}
}
