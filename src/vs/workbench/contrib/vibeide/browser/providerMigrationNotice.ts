/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { MIGRATED_PROVIDER_FILES, MovedProvider, ProviderMigrationReport } from '../common/providerMigration.js';
import { LEGACY_OPENCODE_GO_NOTICE_KEY, PROVIDER_FILES_MIGRATION_KEY, PROVIDER_MIGRATION_NOTICE_KEY } from '../common/storageKeys.js';
import { displayInfoOfProviderName } from '../common/vibeideSettingsTypes.js';
import { IVibeDynamicProvidersService } from './vibeDynamicProvidersService.js';
import { vibeLog } from '../common/vibeLog.js';

/** Название провайдера в уведомлении: для вендоров из набора — имя вендора, для OpenCode Go — своё. */
function titleOf(configId: string): string {
	return configId === 'opencode-go' ? 'OpenCode Go' : displayInfoOfProviderName(configId).title;
}

/** Что именно перенесено провайдеру, словами: «ключ, выбранная модель». */
function detailsOf(moved: MovedProvider): string {
	const parts: string[] = [];
	if (moved.movedKey) {
		parts.push(localize('vibeide.providerMigration.key', "ключ"));
	}
	if (moved.movedParams.length > 0) {
		parts.push(localize('vibeide.providerMigration.params', "значения полей карточки"));
	}
	if (moved.movedSelections > 0) {
		parts.push(localize('vibeide.providerMigration.selection', "выбранная модель"));
	}
	if (moved.movedVisibleModels > 0 || moved.movedCustomModels > 0) {
		parts.push(localize('vibeide.providerMigration.models', "включённые модели"));
	}
	return parts.join(', ');
}

/**
 * Один раз говорит человеку, что часть встроенных провайдеров теперь подключается файлами набора.
 *
 * Перенос ключей, значений полей и выбранных моделей идёт при чтении настроек (`providerMigration.ts`), когда окна для
 * уведомления ещё нет, поэтому отчёт ждёт в хранилище, а показывается здесь, после того как окно собрано. Показан — ключ удалён.
 * Свежему профилю и тому, кто этих провайдеров не использовал, отчёта нет, и сказать ему нечего.
 *
 * Что называется прямо: провайдеры живут в «Свои провайдеры» настроек, а файл набора засевается при открытии папки проекта.
 * Здесь же создаются файлы провайдеров, которых в наборе нет («Совместимо с OpenAI API» для тех, у кого был свой адрес).
 */
export class ProviderMigrationNoticeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.providerMigrationNotice';

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@IVibeDynamicProvidersService private readonly _dynamicProviders: IVibeDynamicProvidersService,
	) {
		super();
		// Уведомление прежнего вида — только об OpenCode Go — заменено этим: недопоказанное теперь не нужно
		this._storageService.remove(LEGACY_OPENCODE_GO_NOTICE_KEY, StorageScope.APPLICATION);
		void this._createPendingFiles();
		this._showIfPending();
	}

	private _showIfPending(): void {
		const raw = this._storageService.get(PROVIDER_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return;
		}
		// Ключ удаляется до показа: уведомление, которое не удалось построить, не должно возвращаться при каждом запуске
		this._storageService.remove(PROVIDER_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION);
		let report: ProviderMigrationReport;
		try {
			report = JSON.parse(raw) as ProviderMigrationReport;
		} catch {
			return;
		}
		if (!Array.isArray(report.moved) || report.moved.length === 0) {
			return;
		}
		const names = report.moved.map(moved => titleOf(moved.configId)).join(', ');
		const details = report.moved.map(moved => `${titleOf(moved.configId)}: ${detailsOf(moved)}`).join('; ');
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeide.providerMigration.notice',
				"Провайдеры {0} больше не встроенные: они подключаются файлами набора из `.vibe/providers/` и стоят в Настройки → Облачные провайдеры → «Свои провайдеры». Перенесено — {1}. Если провайдера нет в списке, откройте папку проекта или примените обновление окружения `.vibe`.",
				names,
				details,
			),
		});
	}

	/**
	 * Создаёт в `~/.vibe/providers/` файлы провайдеров, которых нет в наборе. Существующий файл не трогается: человек мог
	 * сам завести провайдера с таким именем, и его правки дороже заготовки.
	 */
	private async _createPendingFiles(): Promise<void> {
		const raw = this._storageService.get(PROVIDER_FILES_MIGRATION_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return;
		}
		let ids: unknown;
		try {
			ids = JSON.parse(raw);
		} catch {
			this._storageService.remove(PROVIDER_FILES_MIGRATION_KEY, StorageScope.APPLICATION);
			return;
		}
		try {
			const home = await this._pathService.userHome();
			const directory = joinPath(home, '.vibe', 'providers');
			let created = false;
			for (const id of Array.isArray(ids) ? ids : []) {
				const file = typeof id === 'string' ? MIGRATED_PROVIDER_FILES[id] : undefined;
				if (!file) {
					continue;
				}
				const target = joinPath(directory, file.fileName);
				if (await this._fileService.exists(target)) {
					continue;
				}
				await this._fileService.writeFile(target, VSBuffer.fromString(file.text));
				created = true;
			}
			// Запись удаляется только после успеха: не вышло — попробуем при следующем запуске
			this._storageService.remove(PROVIDER_FILES_MIGRATION_KEY, StorageScope.APPLICATION);
			if (created) {
				await this._dynamicProviders.reload();
			}
		} catch (error) {
			vibeLog.warn('providerMigration', 'не удалось создать файл провайдера в ~/.vibe/providers, повторим при следующем запуске', error);
		}
	}
}

// AfterRestored: уведомление нужно только тогда, когда окно уже есть
registerWorkbenchContribution2(ProviderMigrationNoticeContribution.ID, ProviderMigrationNoticeContribution, WorkbenchPhase.AfterRestored);
