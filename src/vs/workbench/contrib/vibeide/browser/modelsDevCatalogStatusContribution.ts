/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IModelsDevCatalogStatusService, ModelsDevCatalogStatus } from '../common/modelsDevCatalogStatusService.js';
import { IVibeModalService } from '../common/vibeModalService.js';

/**
 * On startup, asks main-process whether the models.dev catalog loaded successfully.
 * Triggers the lazy first fetch as a side-effect — useful as a prefetch so the catalog
 * is ready before the user sends their first chat message.
 *
 * Notifies the user only in degraded states:
 *   - 'loaded_from_local': VibeModal (was INFO toast pre-A) — important info that users
 *     used to dismiss accidentally. Semantic source label («рядом с VibeIDE.exe» /
 *     «встроенный снимок» / «из пользовательских данных») replaces raw path display.
 *   - 'failed': VibeModal with copy-URL button + path list + open-URL action. Sticky.
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
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		// Fire-and-forget. Status check failure (IPC down etc) is non-critical.
		void this._check(statusService, modalService, openerService, clipboardService);

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
			if (e.affectsConfiguration('vibeide.catalog.modelsDevCacheTtlHours')) pushTtl();
		}));
	}

	private async _check(
		statusService: IModelsDevCatalogStatusService,
		modalService: IVibeModalService,
		openerService: IOpenerService,
		clipboardService: IClipboardService,
	): Promise<void> {
		let status: ModelsDevCatalogStatus;
		try {
			status = await statusService.getStatus();
		} catch (e) {
			// IPC down — nothing actionable to show. main-process console already logged.
			console.warn('[modelsDevCatalogStatus] status query failed', e);
			return;
		}

		if (status.state === 'loaded_from_network' || status.state === 'unloaded') return;

		if (status.state === 'loaded_from_local') {
			const sourceLabel = labelOf(status.source);
			const body =
				`Каталог моделей models.dev недоступен по сети.\n\n` +
				`Загружен ${sourceLabel}.\n\n` +
				`Aggregator-провайдеры (openCode, openCodeZen) продолжат работать.\n\n` +
				`Чтобы обновить каталог — скачайте ${MODELS_DEV_URL} при наличии сети и положите рядом с VibeIDE.exe (файл с именем models.dev.json).`;
			void modalService.showModal<'ok' | 'copyUrl'>({
				title: 'Каталог моделей: офлайн режим',
				body,
				icon: 'info',
				buttons: [
					{ id: 'copyUrl', label: 'Скопировать URL', role: 'secondary' },
					{ id: 'ok', label: 'Понятно', role: 'primary' },
				],
			}).then(async result => {
				if (result.buttonId === 'copyUrl') {
					await clipboardService.writeText(MODELS_DEV_URL);
				}
			});
			return;
		}

		// state === 'failed'
		const pathsText = status.candidatePaths.length > 0
			? status.candidatePaths.map(p => `  • ${p}`).join('\n')
			: '  (нет доступных путей)';
		const body =
			`Каталог моделей models.dev недоступен по сети, локальный снимок не найден.\n\n` +
			`Модели minimax/qwen через openCode/openCodeZen могут возвращать пустые ответы.\n\n` +
			`Скачайте каталог с ${status.catalogUrl} и сохраните как «models.dev.json» по одному из путей (приоритет сверху вниз):\n${pathsText}`;
		void modalService.showModal<'openUrl' | 'copyUrl' | 'close'>({
			title: 'Каталог моделей: ошибка загрузки',
			body,
			icon: 'warning',
			buttons: [
				{ id: 'close', label: 'Закрыть', role: 'secondary' },
				{ id: 'copyUrl', label: 'Скопировать URL', role: 'secondary' },
				{ id: 'openUrl', label: 'Открыть models.dev/api.json', role: 'primary' },
			],
		}).then(async result => {
			if (result.buttonId === 'openUrl') {
				await openerService.open(URI.parse(status.catalogUrl));
			} else if (result.buttonId === 'copyUrl') {
				await clipboardService.writeText(status.catalogUrl);
			}
		});
	}
}

const MODELS_DEV_URL = 'https://models.dev/api.json';

const labelOf = (source: 'exeDir' | 'bundled' | 'userData'): string => {
	switch (source) {
		case 'exeDir':   return 'снимок, который вы положили рядом с VibeIDE.exe';
		case 'bundled':  return 'встроенный снимок (из ресурсов установки)';
		case 'userData': return 'кэшированный снимок из пользовательских данных';
	}
};

registerWorkbenchContribution2(
	ModelsDevCatalogStatusContribution.ID,
	ModelsDevCatalogStatusContribution,
	WorkbenchPhase.AfterRestored,
);
