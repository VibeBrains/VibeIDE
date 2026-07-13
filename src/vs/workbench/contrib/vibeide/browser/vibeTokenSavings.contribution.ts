/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IVibeTokenSavingsService } from './vibeTokenSavingsService.js';

registerAction2(
	class VibeTokenSavingsReport extends Action2 {
		constructor() {
			super({
				id: 'vibeide.tokenSavings.report',
				title: localize2('vibeide.tokenSavings.report', 'Экономия на сжатии вывода'),
				category: localize2('vibeCategory', 'VibeIDE'),
				f1: true,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const savings = accessor.get(IVibeTokenSavingsService).snapshot();
			const notice = accessor.get(INotificationService);
			if (savings.totalSavedChars <= 0) {
				notice.info(localize('vibeide.tokenSavings.none', 'Сжатие вывода пока ничего не сэкономило в этой сессии.'));
				return;
			}
			notice.info(localize(
				'vibeide.tokenSavings.summary',
				'Сжатие вывода за сессию: сэкономлено ~{0} токенов ({1} симв.). Терминал: {2} вызовов, {3} симв. MCP: {4} вызовов, {5} симв.',
				savings.totalSavedTokensApprox.toLocaleString(),
				savings.totalSavedChars.toLocaleString(),
				savings.terminal.calls.toLocaleString(),
				savings.terminal.savedChars.toLocaleString(),
				savings.mcp.calls.toLocaleString(),
				savings.mcp.savedChars.toLocaleString(),
			));
		}
	},
);
