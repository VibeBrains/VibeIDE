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
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ViewPane, IViewPaneOptions } from '../../../../browser/parts/views/viewPane.js';
import { IVibeServerService } from './vibeServerService.js';
import { VibeServerCommands } from './vibeServerConstants.js';

const $ = DOM.$;

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
		@IVibeServerService private readonly _vibeServerService: IVibeServerService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this._vibeServerService.onDidChangeStatus(() => this._render()));
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
