/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CONFIG_MAX_FILES, IVibeCodeIndexService } from './vibeCodeIndexService.js';

/** Opens the limit setting. Registered here because the status entry is its only caller. */
const OPEN_LIMIT_SETTING = 'vibeide.codeNavigation.openLimitSetting';
CommandsRegistry.registerCommand(OPEN_LIMIT_SETTING, (accessor: ServicesAccessor) => {
	void accessor.get(IPreferencesService).openSettings({ query: CONFIG_MAX_FILES });
});

/**
 * Постоянная отметка о том, что индекс неполный.
 *
 * WHY on top of the one-time warning: a toast is shown once and dismissed by the next thing that
 * needs the screen. «Определение не найдено» from a truncated index looks exactly like «такого
 * метода нет», so the difference between the two has to stay visible while it is true — not for the
 * five seconds after the scan ends.
 *
 * Shown ONLY while something is actually truncated. A permanent «all good» badge is noise: the
 * normal case needs no reporting.
 */
class VibeCodeIndexStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeCodeIndexStatus';

	private readonly _entry = this._register(new MutableDisposable());

	constructor(
		@IVibeCodeIndexService private readonly _index: IVibeCodeIndexService,
		@IStatusbarService private readonly _statusbar: IStatusbarService,
	) {
		super();
		this._register(this._index.onDidFinishScan(() => this._update()));
		this._update();
	}

	private _update(): void {
		const truncated = this._index.status().filter(status => status.truncated);
		if (truncated.length === 0) {
			this._entry.clear();
			return;
		}
		const languages = truncated.map(status => status.languageId).join(', ');
		this._entry.value = this._statusbar.addEntry({
			name: localize('vibeide.codeIndex.statusName', 'Индекс навигации'),
			// The warning colour, because the consequence is a wrong answer, not a slow one.
			text: `$(${Codicon.warning.id}) ${localize('vibeide.codeIndex.statusText', 'индекс неполный: {0}', languages)}`,
			ariaLabel: localize('vibeide.codeIndex.statusAria', 'Индекс навигации неполный для языков: {0}', languages),
			tooltip: localize('vibeide.codeIndex.statusTooltip', 'Обход остановился на пределе файлов, поэтому переход к определению может не найти то, что в проекте есть. Нажмите, чтобы поднять предел.'),
			command: {
				id: OPEN_LIMIT_SETTING,
				title: localize('vibeide.codeIndex.openSetting', 'Изменить предел'),
			},
		}, 'vibeide.codeIndexStatus', StatusbarAlignment.RIGHT, 100);
	}
}

registerWorkbenchContribution2(VibeCodeIndexStatusContribution.ID, VibeCodeIndexStatusContribution, WorkbenchPhase.AfterRestored);
