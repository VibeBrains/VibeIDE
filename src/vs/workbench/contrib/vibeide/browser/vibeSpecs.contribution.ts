/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
	ViewContentGroups,
} from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { registerVibeideFaSolidIcon } from './vibeideFontAwesomeSolid.js';
import {
	VIBE_SPECS_PRODUCT_FILE,
	VIBE_SPECS_VIEW_ID,
	VIBE_SPECS_VIEWLET_ID,
	VibeSpecsCommands,
} from './vibeSpecsConstants.js';
import { VibeSpecsViewPane } from './vibeSpecsViewPane.js';
import { IVibeSpecsService } from './vibeSpecsService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';

const whenVibeSpecsViewTitle = ContextKeyExpr.equals('view', VIBE_SPECS_VIEW_ID);

/** FA6 Free Solid file-lines (U+F15C) — a document, reads as a written spec. */
const vibeSpecsActivityGlyph = registerVibeideFaSolidIcon(
	'vibeide-vibe-specs-activity',
	'',
	localize('vibeSpecs.activityIcon', 'Иконка «Спеки» на панели активности'),
);

const vibeSpecsViewTabIcon = registerVibeideFaSolidIcon(
	'vibeide-vibe-specs-view-tab',
	'',
	localize('vibeSpecs.viewTab', 'Вкладка представления «Спеки»'),
);

const vibeSpecsViewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const vibeSpecsViewPaneWrapper = vibeSpecsViewContainerRegistry.registerViewContainer(
	{
		id: VIBE_SPECS_VIEWLET_ID,
		title: localize2('vibeSpecs.containerTitle', 'Спеки'),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIBE_SPECS_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: vibeSpecsActivityGlyph,
		order: 0.6,
	},
	ViewContainerLocation.Sidebar,
	{ doNotRegisterOpenCommand: true },
);

const vibeSpecsViewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);
vibeSpecsViewsRegistry.registerViews(
	[
		{
			id: VIBE_SPECS_VIEW_ID,
			name: localize2('vibeSpecs.viewName', 'Спеки'),
			containerIcon: vibeSpecsViewTabIcon,
			ctorDescriptor: new SyncDescriptor(VibeSpecsViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			weight: 100,
			order: 1,
		},
	],
	vibeSpecsViewPaneWrapper,
);

vibeSpecsViewsRegistry.registerViewWelcomeContent(VIBE_SPECS_VIEW_ID, {
	content: localize(
		'vibeSpecs.welcome',
		'Спек пока нет.\nСпеки живут в `specs/<id>/` и описывают фичу до кода (PRODUCT.md — поведение, TECH.md — реализация).\n[Новая спека](command:{0})',
		VibeSpecsCommands.newSpec,
	),
	when: 'default',
	group: ViewContentGroups.Open,
	order: 1,
});

const vibeCategory = localize2('vibeCategory', 'VibeIDE');

registerAction2(
	class VibeSpecsRefresh extends Action2 {
		constructor() {
			super({
				id: VibeSpecsCommands.refresh,
				title: localize2('vibeSpecs.refresh', 'Спеки: Обновить'),
				icon: Codicon.refresh,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 10, when: whenVibeSpecsViewTitle },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			accessor.get(IVibeSpecsService).refresh();
		}
	},
);

registerAction2(
	class VibeSpecsNewSpec extends Action2 {
		constructor() {
			super({
				id: VibeSpecsCommands.newSpec,
				title: localize2('vibeSpecs.newSpec', 'Спеки: Новая спека'),
				icon: Codicon.add,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 11, when: whenVibeSpecsViewTitle },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const workspace = accessor.get(IWorkspaceContextService);
			const quick = accessor.get(IQuickInputService);
			const notice = accessor.get(INotificationService);
			const files = accessor.get(IFileService);
			const editor = accessor.get(IEditorService);
			const specs = accessor.get(IVibeSpecsService);

			if (workspace.getWorkbenchState() === WorkbenchState.EMPTY) {
				notice.info(localize('vibeSpecs.needWorkspace', 'Откройте папку или рабочую область, чтобы создать спеку.'));
				return;
			}
			const root = workspace.getWorkspace().folders[0]?.uri;
			if (!root) {
				return;
			}

			const specId = (await quick.input({
				title: localize('vibeSpecs.newSpec.title', 'Идентификатор спеки'),
				placeHolder: localize('vibeSpecs.newSpec.placeholder', 'например PROJ-1234 или short-feature-name'),
				validateInput: async v => {
					const t = v.trim();
					if (!t) {
						return localize('vibeSpecs.newSpec.empty', 'Идентификатор не может быть пустым');
					}
					if (!/^[A-Za-z0-9._-]+$/.test(t)) {
						return localize('vibeSpecs.newSpec.invalid', 'Только латиница, цифры, дефис, точка и подчёркивание');
					}
					return undefined;
				},
			}))?.trim();
			if (!specId) {
				return;
			}

			const productUri = joinPath(specs.specsRootFor(root), specId, VIBE_SPECS_PRODUCT_FILE);
			if (await files.exists(productUri)) {
				notice.info(localize('vibeSpecs.newSpec.exists', 'Спека «{0}» уже существует.', specId));
				await editor.openEditor({ resource: productUri, options: { pinned: false } });
				return;
			}

			// Minimal seed: the write-product-spec skill fills the real Behavior section. Kept tiny on
			// purpose — the skeleton reference lives in .vibe/skills/write-product-spec/references/.
			const seed = [
				`# ${specId}`,
				'',
				'## Summary',
				'',
				'<1–3 предложения: что за фича и желаемый результат.>',
				'',
				'## Behavior',
				'',
				'1. <Инвариант: конкретное наблюдаемое поведение.>',
				'',
			].join('\n');
			await files.writeFile(productUri, VSBuffer.fromString(seed));
			specs.refresh();
			await editor.openEditor({ resource: productUri, options: { pinned: false } });
		}
	},
);
