/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Vibe Deploy — native seam (roadmap VD.3). A thin bridge that hands the deploy task to the
 * agent, which runs the `vibe-deploy` skill. The skill itself enforces "confirm before any
 * outward action", so kicking off the planning turn here is safe.
 */

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IChatThreadService } from './chatThreadService.js';
import { VIBE_SERVER_VIEW_ID } from './vibeServer/vibeServerConstants.js';

const DEPLOY_REQUEST = localize('vibeide.vibeDeploy.request', "Задеплой этот проект, используя скилл vibe-deploy. Сначала проанализируй проект и покажи план; не выполняй внешних действий (создание инфраструктуры, push, смена DNS) без моего подтверждения.");

registerAction2(
	class VibeDeployRun extends Action2 {
		constructor() {
			super({
				id: 'vibeide.vibeDeploy.deploy',
				title: localize2('vibeDeploy.deploy', 'Vibe Deploy: Задеплоить проект'),
				icon: Codicon.cloudUpload,
				category: localize2('vibeCategory', 'VibeIDE'),
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 8, when: ContextKeyExpr.equals('view', VIBE_SERVER_VIEW_ID) },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const chat = accessor.get(IChatThreadService);
			const notice = accessor.get(INotificationService);

			let threadId = chat.state.currentThreadId;
			if (!threadId) {
				chat.openNewThread();
				threadId = chat.state.currentThreadId;
			}
			if (!threadId) {
				notice.info(localize('vibeDeploy.noThread', "Не удалось открыть чат для запуска деплоя."));
				return;
			}
			await chat.addUserMessageAndStreamResponse({ userMessage: DEPLOY_REQUEST, threadId });
		}
	},
);
