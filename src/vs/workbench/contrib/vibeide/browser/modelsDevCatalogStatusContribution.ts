/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IModelsDevCatalogStatusService, ModelsDevCatalogStatus } from '../common/modelsDevCatalogStatusService.js';
import { labelOfSource, MODELS_DEV_URL } from '../common/modelsDevCatalogConstants.js';
import { IVibeModalService } from '../common/vibeModalService.js';
import { localize } from '../../../../nls.js';

/**
 * On startup, asks main-process whether the models.dev catalog loaded successfully.
 * Triggers the lazy first fetch as a side-effect — useful as a prefetch so the catalog
 * is ready before the user sends their first chat message.
 *
 * Notifies the user only in degraded states:
 *   - 'loaded_from_local': lightweight INFO toast (was modal in audit Z.1 — reverted in
 *     Z.12 because the modal applied `inert` to the entire workbench at startup, blocking
 *     menu/sidebar/buttons; on offline work-machines this turned every cold-start into a
 *     full-IDE freeze). Toast is non-blocking + dismissable; user can hit «Перепроверить»
 *     for the recheck command, or simply ignore — IDE remains fully interactive.
 *   - 'failed': VibeModal stays (no snapshot at all is a real action-required state —
 *     user must download models.dev/api.json before LLM calls work).
 *
 * Why the registration-time fetch: aiSdkAdapter calls getCatalog() lazily on the first LLM
 * request. Without this prefetch, the failure modal would only fire after the user already
 * hit a broken minimax response — too late to be helpful. Doing it at AfterRestored phase
 * keeps it off the critical startup path while still warning the user before they're
 * blocked.
 */
export class ModelsDevCatalogStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.modelsDevCatalogStatus';

	constructor(
		@IModelsDevCatalogStatusService statusService: IModelsDevCatalogStatusService,
		@IVibeModalService modalService: IVibeModalService,
		@IOpenerService openerService: IOpenerService,
		@IClipboardService clipboardService: IClipboardService,
		@INotificationService notificationService: INotificationService,
		@ICommandService commandService: ICommandService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		// Fire-and-forget. Status check failure (IPC down etc) is non-critical.
		void this._check(statusService, modalService, openerService, clipboardService, notificationService, commandService);

		// Push the user's `modelsDevCacheTtlHours` setting to main-process at
		// startup, then re-push whenever it changes. Without this, the setting
		// would be silently ignored — modelsDevCatalog reads from an env var
		// that main-process owns, and renderer<->main don't share process.env.
		const pushTtl = () => {
			const hours = configurationService.getValue<number>('vibeide.catalog.modelsDevCacheTtlHours') ?? 24;
			void statusService.setDiskCacheTtlHours(hours).catch(() => { /* IPC down — config will be re-tried on next change */ });
		};
		pushTtl();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.catalog.modelsDevCacheTtlHours')) { pushTtl(); }
		}));
	}

	private async _check(
		statusService: IModelsDevCatalogStatusService,
		modalService: IVibeModalService,
		openerService: IOpenerService,
		clipboardService: IClipboardService,
		notificationService: INotificationService,
		commandService: ICommandService,
	): Promise<void> {
		let status: ModelsDevCatalogStatus;
		try {
			status = await statusService.getStatus();
		} catch (e) {
			// IPC down — nothing actionable to show. main-process console already logged.
			vibeLog.warn('modelsDevCatalogStatus', '[modelsDevCatalogStatus] status query failed', e);
			return;
		}

		if (status.state === 'loaded_from_network' || status.state === 'unloaded') { return; }

		if (status.state === 'loaded_from_local') {
			// Z.12.4: non-blocking modal — centred for visibility, doesn't apply
			// inert to workbench (corporate machines previously got menu/sidebar
			// frozen at startup). Replaces the brief Z.12.1 toast revert; user
			// wanted modal-style attention without the blocking side-effect.
			const sourceLabel = labelOfSource(status.source);
			void modalService.showImportantInfoModal({
				title: localize('vibeide.modelsDev.offlineMode.title', 'Каталог моделей: офлайн режим'),
				body: localize(
					'vibeide.modelsDev.offlineMode.body',
					'Загружен {0}.\n\nAggregator-провайдеры (openCodeGo, openCodeZen) продолжают работать.\n\nЧтобы обновить каталог — скачайте {1} при наличии сети и положите рядом с VibeIDE.exe (файл с именем models.dev.json), либо вызовите «Перепроверить каталог models.dev» в Command Palette.',
					sourceLabel,
					MODELS_DEV_URL,
				),
				icon: 'info',
				size: 'medium',
				blocking: false,
				okLabel: localize('vibeide.modal.gotIt', 'Понятно'),
				secondaryAction: {
					id: 'copyUrl',
					label: localize('vibeide.modal.copyUrl', 'Скопировать URL'),
					onClick: async () => { await clipboardService.writeText(MODELS_DEV_URL); },
				},
			});
			// commandService unused in this branch but retained for failed-state path
			void commandService;
			void notificationService;
			return;
		}

		// state === 'failed'
		const pathsText = status.candidatePaths.length > 0
			? status.candidatePaths.map(p => `  • ${p}`).join('\n')
			: localize('vibeide.modelsDev.noPaths', '  (нет доступных путей)');
		const body = localize(
			'vibeide.modelsDev.failed.body',
			'Каталог моделей models.dev недоступен по сети, локальный снимок не найден.\n\nМодели minimax/qwen через openCodeGo/openCodeZen могут возвращать пустые ответы.\n\nСкачайте каталог с {0} и сохраните как «models.dev.json» по одному из путей (приоритет сверху вниз):\n{1}',
			MODELS_DEV_URL,
			pathsText,
		);
		void modalService.showModal<'openUrl' | 'copyUrl' | 'close'>({
			title: localize('vibeide.modelsDev.failed.title', 'Каталог моделей: ошибка загрузки'),
			body,
			icon: 'warning',
			buttons: [
				{ id: 'close', label: localize('vibeide.modal.close', 'Закрыть'), role: 'secondary' },
				{ id: 'copyUrl', label: localize('vibeide.modal.copyUrl', 'Скопировать URL'), role: 'secondary' },
				{ id: 'openUrl', label: localize('vibeide.modelsDev.openUrl', 'Открыть models.dev/api.json'), role: 'primary' },
			],
		}).then(async result => {
			if (result.buttonId === 'openUrl') {
				await openerService.open(URI.parse(MODELS_DEV_URL));
			} else if (result.buttonId === 'copyUrl') {
				await clipboardService.writeText(MODELS_DEV_URL);
			}
		});
	}
}

registerWorkbenchContribution2(
	ModelsDevCatalogStatusContribution.ID,
	ModelsDevCatalogStatusContribution,
	WorkbenchPhase.AfterRestored,
);
