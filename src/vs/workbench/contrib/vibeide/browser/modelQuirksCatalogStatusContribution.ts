/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IModelQuirksCatalogStatusService } from '../common/modelQuirksCatalogStatusService.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { toAction } from '../../../../base/common/actions.js';

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
		if (!status.staleExeAdjacent) { return; }

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
			title: localize2('vibeide.modelQuirks.refresh', 'Обновить каталог квирков моделей (model-quirks) с CDN'),
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
			title: localize2('vibeide.modelQuirks.showStatus', 'Показать активный каталог квирков моделей'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const statusService = accessor.get(IModelQuirksCatalogStatusService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);
		const s = await statusService.getStatus().catch(() => null);
		if (!s) {
			notificationService.notify({ severity: Severity.Warning, message: localize('vibeide.modelQuirks.showStatus.unavailable', 'Статус каталога квирков недоступен (IPC).') });
			return;
		}
		// Explain WHERE the active catalog actually lives (the old toast only named the source —
		// "CDN-кэш" — without telling the user where to find/edit it).
		const where = s.source === 'exeAdjacent'
			? localize('vibeide.modelQuirks.where.exe', 'файл рядом с VibeIDE.exe: {0}', s.exeAdjacentPath ?? '?')
			: s.source === 'cdn'
				? localize('vibeide.modelQuirks.where.cdn', 'авто-обновляемый кэш CDN (управляется приложением; отдельного файла для ручной правки нет — чтобы переопределить, положите model-quirks.json рядом с VibeIDE.exe)')
				: s.source === 'bundled'
					? localize('vibeide.modelQuirks.where.bundled', 'встроенный каталог сборки (обновится при загрузке с CDN или через exe-adjacent файл)')
					: localize('vibeide.modelQuirks.where.empty', 'каталог не загружен — действуют дефолты провайдеров');

		const actions = [
			toAction({
				id: 'vibeide.modelQuirks.refresh',
				label: localize('vibeide.modelQuirks.action.refresh', 'Обновить с CDN'),
				run: () => { void commandService.executeCommand('vibeide.modelQuirks.refresh'); },
			}),
		];
		if (s.exeAdjacentPath) {
			actions.push(toAction({
				id: 'vibeide.modelQuirks.openFile',
				label: localize('vibeide.modelQuirks.action.open', 'Открыть файл'),
				run: () => { void commandService.executeCommand('vscode.open', URI.file(s.exeAdjacentPath!)); },
			}));
		}

		notificationService.notify({
			severity: Severity.Info,
			message: localize('vibeide.modelQuirks.showStatus.msg2',
				'Каталог квирков моделей. Где: {0}. Дата активного: {1}; доступно на CDN: {2}.{3}',
				where, s.activeDate || '—', s.latestAvailableDate || '—',
				s.staleExeAdjacent ? localize('vibeide.modelQuirks.showStatus.stale', ' ⚠ exe-adjacent старее доступного.') : ''),
			actions: { primary: actions },
		});
	}
});
