/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ведущий активного треда для того, что показывает «текущую модель» вне ленты чата: строка состояния
 *
 * Выбор агента лежит на треде, а выбор модели — на функции «Чат», поэтому показ сам по себе их не различит
 */

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ChatLeader, chatLeaderKey, chatLeaderOf } from '../common/chatLeader.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { IChatThreadService } from './chatThreadService.js';

/** Кто ведёт тред, открытый сейчас */
export function currentChatLeader(threads: IChatThreadService, settings: IVibeideSettingsService): ChatLeader {
	const { allThreads, currentThreadId } = threads.state;
	return chatLeaderOf(allThreads[currentThreadId], settings.state.modelSelectionOfFeature['Chat']);
}

/**
 * Зовёт `listener`, когда активный тред сменил ведущего: другой тред с другим агентом, агент выбран или снят
 * Сервис чата сообщает о любом изменении состояния (каждое сообщение ленты), поэтому без сравнения ключа
 * показ перерисовывался бы на каждом куске ответа
 */
export function onDidChangeChatLeader(threads: IChatThreadService, settings: IVibeideSettingsService, listener: () => void): IDisposable {
	let last = chatLeaderKey(currentChatLeader(threads, settings));
	return threads.onDidChangeCurrentThread(() => {
		const key = chatLeaderKey(currentChatLeader(threads, settings));
		if (key !== last) {
			last = key;
			listener();
		}
	});
}
