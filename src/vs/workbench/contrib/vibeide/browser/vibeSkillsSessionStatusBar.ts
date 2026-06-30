/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';

const SESSION_KEY = 'vibeide.skills.sessionActiveIds';

/**
 * Compact indicator when workspace limits which skills appear in GUIDELINES discovery.
 */
export class VibeSkillsSessionStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeSkillsSessionStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;
	private _unifiedRow: IDisposable | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
	) {
		super();
		this._wire();
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SESSION_KEY)) { this._refresh(); }
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) { this._wire(); }
		}));
	}

	private _wire(): void {
		this._entry?.dispose(); this._entry = undefined;
		this._unifiedRow?.dispose(); this._unifiedRow = undefined;
		const p = this._entryProps();
		if (!p.text) { return; }
		const unifiedOnly = this._configurationService.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		if (unifiedOnly) {
			this._unifiedRow = this._unified.registerRow({
				id: 'vibeide.skills.session',
				label: p.text,
				tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined,
				priority: 173,
				command: typeof p.command === 'string' ? p.command : undefined,
			});
		} else {
			this._entry = this._statusbarService.addEntry(p, 'vibeide.skills.session', StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 173 }, alignment: StatusbarAlignment.RIGHT });
		}
	}

	private _refresh(): void {
		this._wire();
	}

	override dispose(): void {
		this._unifiedRow?.dispose();
		this._entry?.dispose();
		super.dispose();
	}

	private _entryProps(): IStatusbarEntry {
		const ids = this._configurationService.getValue<string[]>(SESSION_KEY)?.filter(Boolean) ?? [];
		const tipIds = ids.join(', ');
		if (!ids.length) {
			return {
				name: localize('vibeideSkillsSessionSbName', 'VibeIDE скиллы сессии'),
				text: '',
				ariaLabel: localize('vibeideSkillsSessionSbAriaIdle', 'Фильтр скиллов сессии: выключен'),
				tooltip: localize(
					'vibeideSkillsSessionSbTipIdle',
					'Фильтр скиллов сессии не задан. Выполните «VibeIDE: Skills — select for session», чтобы ограничить обнаружение GUIDELINES.'
				),
			};
		}
		return {
			name: localize('vibeideSkillsSessionSbName', 'VibeIDE скиллы сессии'),
			text: localize('vibeideSkillsSessionSbText', 'скиллы:{0}', ids.length),
			ariaLabel: localize('vibeideSkillsSessionSbAria', 'Фильтр скиллов сессии: {0} скиллов', ids.length),
			tooltip: localize(
				'vibeideSkillsSessionSbTip',
				'Обнаружение ограничено: {0}. Нажмите, чтобы открыть выборщик; палитра: «Skills — clear session filter».',
				tipIds
			),
			command: 'vibeide.skills.pickSession',
		};
	}
}

registerWorkbenchContribution2(
	VibeSkillsSessionStatusBarContribution.ID,
	VibeSkillsSessionStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
