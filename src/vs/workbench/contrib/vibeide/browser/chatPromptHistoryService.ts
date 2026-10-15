/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { CHAT_PROMPT_HISTORY_STORAGE_KEY, PROMPT_HISTORY_DEFAULT_MAX, appendPromptToHistory, isRememberablePrompt, parsePromptHistory } from '../common/promptHistory.js';

export interface IChatPromptHistoryService {
	readonly _serviceBrand: undefined;

	/** What was sent from the chat composer in this workspace, oldest first */
	readonly entries: readonly string[];

	/** A message the person sent; whichever target led it, a model or an external agent */
	remember(prompt: string): void;
}

export const IChatPromptHistoryService = createDecorator<IChatPromptHistoryService>('chatPromptHistoryService');

/**
 * The history of the chat composer, ↑ and ↓
 * It is kept in the storage of the workspace: each project has its own list, and what was asked in one is not offered in another
 * One list for every target. The person's phrase is the same whether a model or an agent takes it
 */
export class ChatPromptHistoryService extends Disposable implements IChatPromptHistoryService {
	declare readonly _serviceBrand: undefined;

	private _entries: readonly string[];

	constructor(@IStorageService private readonly _storageService: IStorageService) {
		super();
		this._entries = parsePromptHistory(this._storageService.get(CHAT_PROMPT_HISTORY_STORAGE_KEY, StorageScope.WORKSPACE));
	}

	get entries(): readonly string[] {
		return this._entries;
	}

	remember(prompt: string): void {
		if (!isRememberablePrompt(prompt)) { return; }
		const next = appendPromptToHistory(this._entries, prompt, PROMPT_HISTORY_DEFAULT_MAX);
		if (next.length === this._entries.length && next.every((entry, i) => entry === this._entries[i])) { return; }
		this._entries = next;
		this._storageService.store(CHAT_PROMPT_HISTORY_STORAGE_KEY, JSON.stringify(next), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

registerSingleton(IChatPromptHistoryService, ChatPromptHistoryService, InstantiationType.Delayed);
