/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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

/** Safety net for the recheck IPC call. If main-process hangs (corporate
 *  firewall + slow network + buggy retry), we don't want the loading modal
 *  trapping the user forever. 30s is generous — `getCatalog()` has a 10s
 *  network timeout internally, so 30s covers TWO network attempts + fast-path
 *  fs.stat with margin. */
const RECHECK_TIMEOUT_MS = 30_000;

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
			title: localize2('vibeide.modelsDevCatalog.recheck.title', 'Перепроверить каталог models.dev'),
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
		//
		// Z.12 fix: `dismissible: true` + Cancel button — pre-fix value was
		// `false` AND `loading: true`, which made ESC + backdrop + onBeforeDismiss
		// all reject. A hung IPC call would TRAP the user in the modal with a
		// frozen workbench (inert + no exit path). Now user can ESC out.
		const showLoading = modalSvc.showModal<'cancel'>({
			title: localize('vibeide.modelsDev.recheck.title', 'Перепроверка каталога models.dev'),
			body: localize('vibeide.modelsDev.recheck.body', 'Идёт повторная проверка источников каталога…'),
			icon: 'sync',
			loading: true,
			size: 'small',
			buttons: [{ id: 'cancel', label: localize('vibeide.modal.cancel', 'Отмена'), role: 'secondary' }],
		});

		// Race the IPC recheck against a hard timeout — main-process should
		// finish within 30s (10s network × 2 attempts + fs.stat margin); past
		// that we surface an error rather than hang the modal forever.
		const timeoutSentinel = Symbol('recheckTimeout');
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		const timeoutPromise = new Promise<typeof timeoutSentinel>(resolve => {
			timeoutHandle = setTimeout(() => resolve(timeoutSentinel), RECHECK_TIMEOUT_MS);
		});

		let status: ModelsDevCatalogStatus;
		try {
			const result = await Promise.race([statusSvc.recheck(), timeoutPromise]);
			if (timeoutHandle !== null) { clearTimeout(timeoutHandle); }
			if (result === timeoutSentinel) {
				modalSvc.closeHead();
				await showLoading;
				void modalSvc.errorModal({
					title: localize('vibeide.modelsDev.recheck.timeout.title', 'Перепроверка зависла'),
					body: localize(
						'vibeide.modelsDev.recheck.timeout.body',
						'Recheck не завершился за {0} секунд. Попробуйте позже или перезапустите VibeIDE.',
						RECHECK_TIMEOUT_MS / 1000,
					),
					size: 'small',
				});
				return;
			}
			status = result;
		} catch (e) {
			if (timeoutHandle !== null) { clearTimeout(timeoutHandle); }
			modalSvc.closeHead();
			await showLoading;
			void modalSvc.errorModal({
				title: localize('vibeide.modelsDev.recheck.failed.title', 'Перепроверка не удалась'),
				body: localize('vibeide.modelsDev.recheck.failed.body', 'Ошибка IPC: {0}', e instanceof Error ? e.message : String(e)),
				size: 'small',
			});
			return;
		}

		// If user clicked Cancel in the loading modal, the queue head is already gone.
		// `closeHead()` is then a no-op on empty queue; safe.
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
			// O.15.1 — exeDir is a user-PINNED file with top precedence, not an offline
			// fallback. Saying «сеть недоступна» there is wrong: the network wasn't used
			// BECAUSE the pinned exe-file wins. Branch the wording so a recheck on a pinned
			// catalog is honest about why nothing changed.
			const isPinnedExe = status.source === 'exeDir';
			void modalSvc.showModal<'ok' | 'copyUrl'>({
				title: isPinnedExe
					? localize('vibeide.modelsDev.recheck.pinned.title', 'Каталог models.dev: активен запиненный файл')
					: localize('vibeide.modelsDev.recheck.offline.title', 'Каталог models.dev: офлайн режим'),
				body: isPinnedExe
					? localize(
						'vibeide.modelsDev.recheck.pinned.body',
						'Активен {0} — это приоритетный источник, поэтому сеть не использовалась и перепроверка его НЕ меняет.\n\nЧтобы переключиться на сетевой каталог или обновить — замените файл рядом с VibeIDE.exe свежей версией с {1} либо удалите его, чтобы вернуться к сетевому/встроенному.',
						sourceLabel,
						MODELS_DEV_URL,
					)
					: localize(
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
				if (r.buttonId === 'copyUrl') { await clipboard.writeText(MODELS_DEV_URL); }
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
				if (r.buttonId === 'openUrl') { await opener.open(URI.parse(MODELS_DEV_URL)); }
				else if (r.buttonId === 'copyUrl') { await clipboard.writeText(MODELS_DEV_URL); }
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
