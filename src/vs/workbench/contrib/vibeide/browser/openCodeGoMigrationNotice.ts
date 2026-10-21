/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { OpenCodeGoMigrationReport } from '../common/openCodeGoMigration.js';
import { OPENCODE_GO_MIGRATION_NOTICE_KEY } from '../common/storageKeys.js';

/**
 * Один раз говорит человеку, что OpenCode Go перестал быть встроенным провайдером.
 *
 * Перенос ключа и выбора модели идёт при чтении настроек (`openCodeGoMigration.ts`), когда окна для уведомления ещё нет,
 * поэтому отчёт ждёт в хранилище, а показывается здесь, после того как окно собрано. Показан — ключ удалён.
 * Свежему профилю и тому, кто Go не использовал, отчёта нет, и сказать ему нечего.
 *
 * Что называется прямо: провайдер теперь приходит файлом набора, а файл засевается при открытии папки проекта.
 * Окно без папки провайдера Go не покажет, пока файл не появится, — иначе человек искал бы пропавшего провайдера.
 */
export class OpenCodeGoMigrationNoticeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.openCodeGoMigrationNotice';

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this._showIfPending();
	}

	private _showIfPending(): void {
		const raw = this._storageService.get(OPENCODE_GO_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return;
		}
		// Ключ удаляется до показа: уведомление, которое не удалось построить, не должно возвращаться при каждом запуске
		this._storageService.remove(OPENCODE_GO_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION);
		let report: OpenCodeGoMigrationReport;
		try {
			report = JSON.parse(raw) as OpenCodeGoMigrationReport;
		} catch {
			return;
		}
		const moved: string[] = [];
		if (report.movedKey) {
			moved.push(localize('vibeide.openCodeGo.movedKey', "ключ"));
		}
		if (report.movedSelections > 0) {
			moved.push(localize('vibeide.openCodeGo.movedSelection', "выбранная модель"));
		}
		if (report.movedVisibleModels > 0) {
			moved.push(localize('vibeide.openCodeGo.movedModels', "включённые модели"));
		}
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeide.openCodeGo.notice',
				"OpenCode Go больше не встроенный провайдер: он подключается файлом `.vibe/providers/opencode-go.jsonc` из набора. Перенесено: {0}. Файл появляется при открытии папки проекта — если OpenCode Go нет в списке, откройте папку.",
				moved.join(', '),
			),
		});
	}
}

// AfterRestored: уведомление нужно только тогда, когда окно уже есть
registerWorkbenchContribution2(OpenCodeGoMigrationNoticeContribution.ID, OpenCodeGoMigrationNoticeContribution, WorkbenchPhase.AfterRestored);
