/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { IModelsDevCatalogStatusService, ModelsDevCatalogStatus } from '../common/modelsDevCatalogStatusService.js';
import { labelOfSource, MODELS_DEV_URL } from '../common/modelsDevCatalogConstants.js';
import { IVibeModalService } from '../common/vibeModalService.js';

/** Auto-dismiss timeout for the "Catalog updated" success modal — 4 seconds
 *  is enough to read the one-line message but doesn't interrupt workflow. */
const SUCCESS_AUTO_DISMISS_MS = 4000;

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
		// but a network fetch can take up to FETCH_TIMEOUT_MS ≈10s). We
		// `closeHead()` programmatically instead of `resolveHead('ok')` —
		// avoids the fragile "fake button id" pattern, bypasses the
		// `dismissible: false` guard cleanly.
		const showLoading = modalSvc.showModal<'ok'>({
			title: localize('vibeide.modelsDev.recheck.title', 'Перепроверка каталога models.dev'),
			body: localize('vibeide.modelsDev.recheck.body', 'Идёт повторная проверка источников каталога…'),
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
			modalSvc.closeHead();
			await showLoading;
			void modalSvc.errorModal({
				title: localize('vibeide.modelsDev.recheck.failed.title', 'Перепроверка не удалась'),
				body: localize('vibeide.modelsDev.recheck.failed.body', 'Ошибка IPC: {0}', e instanceof Error ? e.message : String(e)),
				size: 'small',
			});
			return;
		}

		modalSvc.closeHead();
		await showLoading;

		if (status.state === 'loaded_from_network') {
			void modalSvc.successModal({
				title: localize('vibeide.modelsDev.recheck.network.title', 'Каталог models.dev обновлён'),
				body: localize('vibeide.modelsDev.recheck.network.body', 'Загружена свежая версия с сети. Aggregator-провайдеры используют актуальные данные.'),
				autoDismissAfterMs: SUCCESS_AUTO_DISMISS_MS,
			});
			return;
		}

		if (status.state === 'loaded_from_local') {
			const sourceLabel = labelOfSource(status.source);
			void modalSvc.showModal<'ok' | 'copyUrl'>({
				title: localize('vibeide.modelsDev.recheck.offline.title', 'Каталог models.dev: офлайн режим'),
				body: localize(
					'vibeide.modelsDev.recheck.offline.body',
					'Сеть недоступна. Загружен {0}.\n\nЧтобы обновить — скачайте {1} и положите рядом с VibeIDE.exe.',
					sourceLabel,
					MODELS_DEV_URL,
				),
				icon: 'info',
				size: 'medium',
				buttons: [
					{ id: 'copyUrl', label: localize('vibeide.modal.copyUrl', 'Скопировать URL'), role: 'secondary' },
					{ id: 'ok', label: localize('vibeide.modal.gotIt', 'Понятно'), role: 'primary' },
				],
			}).then(async r => {
				if (r.buttonId === 'copyUrl') await clipboard.writeText(MODELS_DEV_URL);
			});
			return;
		}

		if (status.state === 'failed') {
			const pathsText = status.candidatePaths.length > 0
				? status.candidatePaths.map(p => `  • ${p}`).join('\n')
				: localize('vibeide.modelsDev.noPaths', '  (нет доступных путей)');
			void modalSvc.showModal<'openUrl' | 'copyUrl' | 'close'>({
				title: localize('vibeide.modelsDev.recheck.notFound.title', 'Каталог models.dev: не найден'),
				body: localize(
					'vibeide.modelsDev.recheck.notFound.body',
					'Сеть недоступна и локальный снимок не найден.\n\nСкачайте каталог с {0} и сохраните как «models.dev.json» по одному из путей (приоритет сверху вниз):\n{1}',
					MODELS_DEV_URL,
					pathsText,
				),
				icon: 'warning',
				size: 'large',
				buttons: [
					{ id: 'close', label: localize('vibeide.modal.close', 'Закрыть'), role: 'secondary' },
					{ id: 'copyUrl', label: localize('vibeide.modal.copyUrl', 'Скопировать URL'), role: 'secondary' },
					{ id: 'openUrl', label: localize('vibeide.modelsDev.openUrl', 'Открыть models.dev/api.json'), role: 'primary' },
				],
			}).then(async r => {
				if (r.buttonId === 'openUrl') await opener.open(URI.parse(MODELS_DEV_URL));
				else if (r.buttonId === 'copyUrl') await clipboard.writeText(MODELS_DEV_URL);
			});
			return;
		}

		// state === 'unloaded' — should not happen post-recheck, but handle anyway.
		void modalSvc.warnModal({
			title: localize('vibeide.modelsDev.recheck.unloaded.title', 'Каталог models.dev: не инициализирован'),
			body: localize('vibeide.modelsDev.recheck.unloaded.body', 'После перепроверки каталог так и не загрузился. Попробуйте перезапустить VibeIDE.'),
			size: 'small',
		});
	}
}

registerAction2(ModelsDevCatalogRecheckAction);
