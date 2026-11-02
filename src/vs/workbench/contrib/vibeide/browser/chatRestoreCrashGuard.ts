/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
import { ChatRestoreGuardState, decideRestore, RESTORE_STABLE_WINDOW_MS } from '../common/chatRestoreCrashGuard.js';
import { RESTORE_CRASH_GUARD_KEY } from '../common/storageKeys.js';
import { vibeLog } from '../common/vibeLog.js';

/**
 * Защита от петли падений: помнит, что прошлое окно не прожило минуту, и после
 * двух таких падений подряд запрещает восстанавливать вкладки чата. Сами треды
 * остаются на диске — их открывает человек из истории.
 *
 * Отметка пишется в хранилище проекта (WORKSPACE) и сразу сбрасывается на диск: если
 * окно умрёт раньше обычного сохранения, следующий запуск должен её увидеть
 * Своя у каждого окна: при запуске IDE восстанавливает несколько окон разом, и общая отметка
 * засчитала бы соседние окна как падения
 * Обычное закрытие окна отметку снимает: закрыть окно в первую минуту — не падение
 */
export class ChatRestoreCrashGuard extends Disposable {

	private readonly _markStable = this._register(new RunOnceScheduler(() => this._clearMark(), RESTORE_STABLE_WINDOW_MS));

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._register(this._storageService.onWillSaveState(e => {
			if (e.reason === WillSaveStateReason.SHUTDOWN) {
				this._storageService.remove(RESTORE_CRASH_GUARD_KEY, StorageScope.WORKSPACE);
			}
		}));
	}

	/**
	 * Решение на старте: можно ли восстанавливать вкладки. Отметку ставит сразу,
	 * чтобы падение этого окна увидел следующий запуск.
	 */
	decideOnStart(now = Date.now()): boolean {
		const prev = this._readState();
		const { restoreTabs, next } = decideRestore(prev, now);
		this._storageService.store(RESTORE_CRASH_GUARD_KEY, JSON.stringify(next), StorageScope.WORKSPACE, StorageTarget.USER);
		void this._storageService.flush().catch(e => vibeLog.error('chatThread', 'Не удалось сбросить отметку защиты от падений', e));
		this._markStable.schedule();
		return restoreTabs;
	}

	private _readState(): ChatRestoreGuardState | undefined {
		const raw = this._storageService.get(RESTORE_CRASH_GUARD_KEY, StorageScope.WORKSPACE);
		if (!raw) { return undefined; }
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object') { return undefined; }
			return {
				pendingSince: typeof parsed.pendingSince === 'number' ? parsed.pendingSince : undefined,
				crashes: typeof parsed.crashes === 'number' ? parsed.crashes : 0,
			};
		} catch (e) {
			vibeLog.warn('chatThread', 'Повреждённая отметка защиты от падений — начинаем счёт заново', e);
			return undefined;
		}
	}

	/** Окно прожило минуту: падений больше нет, отметка снимается. */
	private _clearMark(): void {
		this._storageService.remove(RESTORE_CRASH_GUARD_KEY, StorageScope.WORKSPACE);
		void this._storageService.flush().catch(e => vibeLog.error('chatThread', 'Не удалось снять отметку защиты от падений', e));
	}
}
