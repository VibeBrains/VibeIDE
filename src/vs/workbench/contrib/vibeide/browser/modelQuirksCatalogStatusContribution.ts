/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IModelQuirksCatalogStatusService } from '../common/modelQuirksCatalogStatusService.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Once per VibeIDE startup: query main-process for the model-quirks catalog status and,
 * if the exe-adjacent override (`model-quirks.json` next to VibeIDE.exe) is STALE —
 * older than the bundled / CDN catalog — show a single non-blocking INFO toast.
 *
 * The exe-adjacent file keeps MAX priority (it's the user's explicit override); we only
 * WARN that it's behind, offering a "refresh from CDN" action. Fires exactly once at
 * AfterRestored — NOT on every quirk lookup (that would spam, per the user's request).
 */
export class ModelQuirksCatalogStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.modelQuirksCatalogStatus';

	constructor(
		@IModelQuirksCatalogStatusService private readonly _statusService: IModelQuirksCatalogStatusService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		// Fire-and-forget. IPC-down is non-critical (the catalog still works in main).
		void this._check();
	}

	private async _check(): Promise<void> {
		let status;
		try {
			status = await this._statusService.getStatus();
		} catch {
			return; // IPC down — nothing actionable; main already has a working catalog.
		}
		if (!status.staleExeAdjacent) return;

		this._notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeide.modelQuirks.staleExeAdjacent',
				'Локальный model-quirks.json рядом с VibeIDE.exe устарел (его дата {0}; доступна {1}). Он сохраняет приоритет, но может не содержать свежих исправлений. Обновите/удалите файл, либо обновите каталог с CDN.',
				status.activeDate || '—',
				status.latestAvailableDate || '—',
			),
			actions: {
				primary: [{
					id: 'vibeide.modelQuirks.refreshFromToast',
					label: localize('vibeide.modelQuirks.refreshAction', 'Обновить с CDN'),
					tooltip: '',
					class: undefined,
					enabled: true,
					checked: undefined,
					run: () => { void this._statusService.refresh(); },
				}],
			},
		});
	}
}

registerWorkbenchContribution2(
	ModelQuirksCatalogStatusContribution.ID,
	ModelQuirksCatalogStatusContribution,
	WorkbenchPhase.AfterRestored,
);

// Command-palette entry: manual CDN refresh — resilience lever when the periodic
// 24h refresh hasn't fired or the user wants the latest catalog now. If an exe-adjacent
// override is active it keeps priority (the toast/notification says so).
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.modelQuirks.refresh',
			title: localize2('vibeide.modelQuirks.refresh', 'VibeIDE: Обновить каталог квирков моделей (model-quirks) с CDN'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const statusService = accessor.get(IModelQuirksCatalogStatusService);
		const notificationService = accessor.get(INotificationService);
		const changed = await statusService.refresh().catch(() => false);
		const status = await statusService.getStatus().catch(() => null);
		const note = status?.source === 'exeAdjacent'
			? localize('vibeide.modelQuirks.refresh.exePinned', ' Активен exe-adjacent файл — он сохраняет приоритет.')
			: '';
		notificationService.notify({
			severity: Severity.Info,
			message: changed
				? localize('vibeide.modelQuirks.refresh.updated', 'Каталог квирков моделей обновлён с CDN.{0}', note)
				: localize('vibeide.modelQuirks.refresh.unchanged', 'Каталог квирков уже актуален (или CDN недоступен).{0}', note),
		});
	}
});

// Diagnostics: "which quirks catalog am I on?" — prints active source / date / path
// without needing DevTools. Read-only.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.modelQuirks.showStatus',
			title: localize2('vibeide.modelQuirks.showStatus', 'VibeIDE: Показать активный каталог квирков моделей'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const statusService = accessor.get(IModelQuirksCatalogStatusService);
		const notificationService = accessor.get(INotificationService);
		const s = await statusService.getStatus().catch(() => null);
		if (!s) {
			notificationService.notify({ severity: Severity.Warning, message: localize('vibeide.modelQuirks.showStatus.unavailable', 'Статус каталога квирков недоступен (IPC).') });
			return;
		}
		const sourceLabel = s.source === 'exeAdjacent' ? `exe-adjacent (${s.exeAdjacentPath ?? '?'})`
			: s.source === 'cdn' ? 'CDN-кэш'
				: s.source === 'bundled' ? 'встроенный (bundled)'
					: 'пусто (provider defaults)';
		notificationService.notify({
			severity: Severity.Info,
			message: localize('vibeide.modelQuirks.showStatus.msg',
				'Каталог квирков: источник — {0}; дата — {1}; доступна — {2}.{3}',
				sourceLabel, s.activeDate || '—', s.latestAvailableDate || '—',
				s.staleExeAdjacent ? localize('vibeide.modelQuirks.showStatus.stale', ' ⚠ exe-adjacent старее доступного.') : ''),
		});
	}
});
