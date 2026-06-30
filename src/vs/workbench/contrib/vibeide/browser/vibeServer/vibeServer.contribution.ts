/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Codicon } from '../../../../../base/common/codicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
	ViewContentGroups,
} from '../../../../common/views.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { registerVibeideFaSolidIcon } from '../vibeideFontAwesomeSolid.js';
import { VibeServerViewPane } from './vibeServerViewPane.js';
import { openLanQr } from './vibeServerQr.js';
import { VibeServerStatusBarContribution } from './vibeServerStatusBar.js';
import { IVibeServerService } from './vibeServerService.js';
import {
	VibeServerCommands,
	VIBE_SERVER_RUNNING_CONTEXT_KEY,
	VIBE_SERVER_VIEW_ID,
	VIBE_SERVER_VIEWLET_ID,
} from './vibeServerConstants.js';

const vibeCategory = localize2('vibeCategory', 'VibeIDE');

const whenServerView = ContextKeyExpr.equals('view', VIBE_SERVER_VIEW_ID);
const whenRunning = ContextKeyExpr.equals(VIBE_SERVER_RUNNING_CONTEXT_KEY, true);
const whenStopped = ContextKeyExpr.notEquals(VIBE_SERVER_RUNNING_CONTEXT_KEY, true);
const whenHtmlResource = ContextKeyExpr.or(
	ContextKeyExpr.equals('resourceExtname', '.html'),
	ContextKeyExpr.equals('resourceExtname', '.htm'),
);

/** FA6 Free Solid server () — reads as a running local server. */
const vibeServerActivityGlyph = registerVibeideFaSolidIcon(
	'vibeide-vibe-server-activity',
	'\uf233',
	localize('vibeServer.activityIcon', 'Иконка Vibe Server на панели активности'),
);

const vibeServerViewTabIcon = registerVibeideFaSolidIcon(
	'vibeide-vibe-server-view-tab',
	'\uf233',
	localize('vibeServer.viewTab', 'Вкладка представления Vibe Server'),
);

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const vibeServerContainer = viewContainerRegistry.registerViewContainer(
	{
		id: VIBE_SERVER_VIEWLET_ID,
		title: localize2('vibeServer.containerTitle', 'Vibe Server'),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIBE_SERVER_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: vibeServerActivityGlyph,
		order: 0.6,
	},
	ViewContainerLocation.Sidebar,
	{ doNotRegisterOpenCommand: true },
);

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);
viewsRegistry.registerViews(
	[
		{
			id: VIBE_SERVER_VIEW_ID,
			name: localize2('vibeServer.viewName', 'Сервер'),
			containerIcon: vibeServerViewTabIcon,
			ctorDescriptor: new SyncDescriptor(VibeServerViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			weight: 100,
			order: 1,
		},
	],
	vibeServerContainer,
);

viewsRegistry.registerViewWelcomeContent(VIBE_SERVER_VIEW_ID, {
	content: localize(
		'vibeServer.welcome',
		'Локальный сервер не запущен.\n[Запустить Vibe Server](command:{0})\n[Поднять окружение (Docker)](command:{1})\nБыстрый предпросмотр проекта без деплоя — встроенный браузер или внешний.',
		VibeServerCommands.start,
		VibeServerCommands.startEnvironment,
	),
	when: 'default',
	group: ViewContentGroups.Open,
	order: 1,
});

registerWorkbenchContribution2(VibeServerStatusBarContribution.ID, VibeServerStatusBarContribution, WorkbenchPhase.AfterRestored);

registerAction2(
	class VibeServerStart extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.start,
				title: localize2('vibeServer.start', 'Vibe Server: Запустить'),
				icon: Codicon.play,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 10, when: ContextKeyExpr.and(whenServerView, whenStopped) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IVibeServerService).start();
		}
	},
);

registerAction2(
	class VibeServerStartEnvironment extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.startEnvironment,
				title: localize2('vibeServer.startEnvironment', 'Vibe Server: Поднять окружение (Docker)'),
				icon: Codicon.package,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 9, when: ContextKeyExpr.and(whenServerView, whenStopped) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IVibeServerService).startEnvironment();
		}
	},
);

registerAction2(
	class VibeServerStop extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.stop,
				title: localize2('vibeServer.stop', 'Vibe Server: Остановить'),
				icon: Codicon.debugStop,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 10, when: ContextKeyExpr.and(whenServerView, whenRunning) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IVibeServerService).stop();
		}
	},
);

registerAction2(
	class VibeServerRestart extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.restart,
				title: localize2('vibeServer.restart', 'Vibe Server: Перезапустить'),
				icon: Codicon.refresh,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: '1_preview', order: 10.5, when: ContextKeyExpr.and(whenServerView, whenRunning) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IVibeServerService).restart();
		}
	},
);

registerAction2(
	class VibeServerOpenPreview extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.openPreview,
				title: localize2('vibeServer.openPreview', 'Vibe Server: Открыть превью'),
				icon: Codicon.openPreview,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 11, when: ContextKeyExpr.and(whenServerView, whenRunning) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IVibeServerService).openPreview('embedded');
		}
	},
);

registerAction2(
	class VibeServerOpenPreviewNewTab extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.openPreviewNewTab,
				title: localize2('vibeServer.openPreviewNewTab', 'Vibe Server: Новое превью (вкладка)'),
				icon: Codicon.splitHorizontal,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: '1_preview', order: 11.5, when: ContextKeyExpr.and(whenServerView, whenRunning) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IVibeServerService).openPreviewNewTab();
		}
	},
);

registerAction2(
	class VibeServerReloadPreview extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.reloadPreview,
				title: localize2('vibeServer.reloadPreview', 'Vibe Server: Обновить превью'),
				icon: Codicon.sync,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 11.2, when: ContextKeyExpr.and(whenServerView, whenRunning) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			accessor.get(IVibeServerService).reloadPreview();
		}
	},
);

registerAction2(
	class VibeServerOpenExternal extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.openExternal,
				title: localize2('vibeServer.openExternal', 'Vibe Server: Открыть во внешнем браузере'),
				icon: Codicon.linkExternal,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 12, when: ContextKeyExpr.and(whenServerView, whenRunning) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IVibeServerService).openPreview('external');
		}
	},
);

registerAction2(
	class VibeServerCopyUrl extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.copyUrl,
				title: localize2('vibeServer.copyUrl', 'Vibe Server: Копировать URL'),
				icon: Codicon.copy,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: '1_preview', order: 13, when: ContextKeyExpr.and(whenServerView, whenRunning) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IVibeServerService).copyUrl();
		}
	},
);

registerAction2(
	class VibeServerPreviewErrorsToChat extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.previewErrorsToChat,
				title: localize2('vibeServer.previewErrorsToChat', 'Vibe Server: Ошибки превью в чат'),
				icon: Codicon.commentDiscussion,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: '1_preview', order: 14, when: ContextKeyExpr.and(whenServerView, whenRunning) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IVibeServerService).sendPreviewErrorsToChat();
		}
	},
);

registerAction2(
	class VibeServerShowLan extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.showLanAddress,
				title: localize2('vibeServer.showLanAddress', 'Vibe Server: Адрес для телефона (LAN)'),
				icon: Codicon.deviceMobile,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: '1_preview', order: 15, when: ContextKeyExpr.and(whenServerView, whenRunning) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IVibeServerService).showLanAddress();
		}
	},
);

registerAction2(
	class VibeServerShowLanQr extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.showLanQr,
				title: localize2('vibeServer.showLanQr', 'Vibe Server: QR для телефона'),
				icon: Codicon.deviceMobile,
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: '1_preview', order: 16, when: ContextKeyExpr.and(whenServerView, whenRunning) }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await openLanQr(accessor);
		}
	},
);

registerAction2(
	class VibeServerOpenSettings extends Action2 {
		constructor() {
			super({
				id: VibeServerCommands.openSettings,
				title: localize2('vibeServer.openSettings', 'Vibe Server: Открыть настройки'),
				category: vibeCategory,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: '2_settings', order: 0, when: whenServerView }],
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IPreferencesService).openUserSettings({ query: 'vibeide.vibeServer' });
		}
	},
);

registerAction2(
	class VibeServerOpenWith extends Action2 {
		constructor() {
			super({
				id: 'vibeide.vibeServer.openWith',
				title: localize2('vibeServer.openWith', 'Открыть в Vibe Server'),
				category: vibeCategory,
				f1: false,
				menu: [
					{ id: MenuId.ExplorerContext, group: 'navigation', order: 20, when: whenHtmlResource },
					{ id: MenuId.EditorContext, group: 'navigation', order: 20, when: whenHtmlResource },
				],
			});
		}
		async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
			const service = accessor.get(IVibeServerService);
			const target = resource ?? accessor.get(IEditorService).activeEditor?.resource;
			if (!target) {
				return;
			}
			await service.openPreviewForResource(target);
		}
	},
);
