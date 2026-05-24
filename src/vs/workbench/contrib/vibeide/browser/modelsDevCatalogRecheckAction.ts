/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { IModelsDevCatalogStatusService, ModelsDevCatalogStatus } from '../common/modelsDevCatalogStatusService.js';
import { MODELS_DEV_URL } from '../common/modelsDevCatalogConstants.js';
import { IVibeModalService } from '../common/vibeModalService.js';

/**
 * Command Palette entry «VibeIDE: Перепроверить каталог models.dev».
 *
 * Use case: user puts a freshly downloaded `models.dev.json` next to
 * `VibeIDE.exe` while the IDE is running. Without this command they'd
 * need to restart to pick it up. The recheck drops the in-memory cache
 * and re-runs the candidate priority chain (exeDir → bundled → userData
 * → network) inside the same session.
 *
 * Wraps the result in a VibeModal so the user gets immediate confirmation
 * of which source was picked up (or failure with copy-URL action).
 */
class ModelsDevCatalogRecheckAction extends Action2 {
	static readonly ID = 'vibeide.modelsDevCatalog.recheck';

	constructor() {
		super({
			id: ModelsDevCatalogRecheckAction.ID,
			title: localize2('vibeide.modelsDevCatalog.recheck.title', 'VibeIDE: Перепроверить каталог models.dev'),
			category: { value: 'VibeIDE Diagnostics', original: 'VibeIDE Diagnostics' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const statusSvc = accessor.get(IModelsDevCatalogStatusService);
		const modalSvc = accessor.get(IVibeModalService);
		const opener = accessor.get(IOpenerService);
		const clipboard = accessor.get(IClipboardService);

		// Loading modal — kept for the duration of the recheck (typically <1s,
		// but a network fetch can take up to FETCH_TIMEOUT_MS ≈10s).
		const showLoading = modalSvc.showModal<'ok'>({
			title: 'Перепроверка каталога models.dev',
			body: 'Идёт повторная проверка источников каталога…',
			icon: 'sync',
			dismissible: false,
			loading: true,
			size: 'small',
			buttons: [{ id: 'ok', label: 'OK', role: 'primary' }],
		});

		let status: ModelsDevCatalogStatus;
		try {
			status = await statusSvc.recheck();
		} catch (e) {
			modalSvc.resolveHead('ok');
			await showLoading;
			void modalSvc.showModal<'ok'>({
				title: 'Перепроверка не удалась',
				body: `Ошибка IPC: ${e instanceof Error ? e.message : String(e)}`,
				icon: 'error',
				size: 'small',
				buttons: [{ id: 'ok', label: 'Понятно', role: 'primary' }],
			});
			return;
		}

		modalSvc.resolveHead('ok');
		await showLoading;

		if (status.state === 'loaded_from_network') {
			void modalSvc.showModal<'ok'>({
				title: 'Каталог models.dev обновлён',
				body: 'Загружена свежая версия с сети. Aggregator-провайдеры используют актуальные данные.',
				icon: 'check',
				size: 'small',
				buttons: [{ id: 'ok', label: 'Отлично', role: 'primary' }],
			});
			return;
		}

		if (status.state === 'loaded_from_local') {
			const sourceLabel = labelOf(status.source);
			void modalSvc.showModal<'ok' | 'copyUrl'>({
				title: 'Каталог models.dev: офлайн режим',
				body:
					`Сеть недоступна. Загружен ${sourceLabel}.\n\n` +
					`Чтобы обновить — скачайте ${MODELS_DEV_URL} и положите рядом с VibeIDE.exe.`,
				icon: 'info',
				size: 'medium',
				buttons: [
					{ id: 'copyUrl', label: 'Скопировать URL', role: 'secondary' },
					{ id: 'ok', label: 'Понятно', role: 'primary' },
				],
			}).then(async r => {
				if (r.buttonId === 'copyUrl') await clipboard.writeText(MODELS_DEV_URL);
			});
			return;
		}

		if (status.state === 'failed') {
			const pathsText = status.candidatePaths.length > 0
				? status.candidatePaths.map(p => `  • ${p}`).join('\n')
				: '  (нет доступных путей)';
			void modalSvc.showModal<'openUrl' | 'copyUrl' | 'close'>({
				title: 'Каталог models.dev: не найден',
				body:
					`Сеть недоступна и локальный снимок не найден.\n\n` +
					`Скачайте каталог с ${status.catalogUrl} и сохраните как «models.dev.json» по одному из путей (приоритет сверху вниз):\n${pathsText}`,
				icon: 'warning',
				size: 'large',
				buttons: [
					{ id: 'close', label: 'Закрыть', role: 'secondary' },
					{ id: 'copyUrl', label: 'Скопировать URL', role: 'secondary' },
					{ id: 'openUrl', label: 'Открыть models.dev/api.json', role: 'primary' },
				],
			}).then(async r => {
				if (r.buttonId === 'openUrl') await opener.open(URI.parse(status.catalogUrl));
				else if (r.buttonId === 'copyUrl') await clipboard.writeText(status.catalogUrl);
			});
			return;
		}

		// state === 'unloaded' — should not happen post-recheck, but handle anyway.
		void modalSvc.showModal<'ok'>({
			title: 'Каталог models.dev: не инициализирован',
			body: 'После перепроверки каталог так и не загрузился. Попробуйте перезапустить VibeIDE.',
			icon: 'warning',
			size: 'small',
			buttons: [{ id: 'ok', label: 'Понятно', role: 'primary' }],
		});
	}
}

const labelOf = (source: 'exeDir' | 'bundled' | 'userData'): string => {
	switch (source) {
		case 'exeDir':   return 'снимок, который вы положили рядом с VibeIDE.exe';
		case 'bundled':  return 'встроенный снимок (из ресурсов установки)';
		case 'userData': return 'кэшированный снимок из пользовательских данных';
	}
};

registerAction2(ModelsDevCatalogRecheckAction);
