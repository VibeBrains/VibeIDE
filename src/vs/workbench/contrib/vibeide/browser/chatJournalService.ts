/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	appendChatJournalEntry,
	CHAT_JOURNAL_MAX_ENTRIES_KEY,
	ChatJournalEntry,
	ChatJournalInput,
	chatJournalLimitOf,
	markChatJournalRead,
	parseChatJournal,
	serializeChatJournal,
	trimChatJournal,
} from '../common/chatJournal.js';

export interface IChatJournalService {
	readonly _serviceBrand: undefined;

	/** Oldest first; every change makes a new array, so an observer may compare by reference */
	readonly entries: readonly ChatJournalEntry[];
	readonly onDidChange: Event<void>;

	/** A service line of the IDE that is not part of the conversation; the same line twice in a row becomes one entry with a counter */
	append(input: ChatJournalInput): void;
	markAllRead(): void;
	clear(): void;
}

export const IChatJournalService = createDecorator<IChatJournalService>('chatJournalService');

const STORAGE_KEY = 'vibeide.chatJournal';
/** A burst of lines is written once, not line by line */
const STORE_DEBOUNCE_MS = 1000;

/**
 * The journal of one window
 * Kept in the storage of the workspace, so it survives a reload of the window; it is not a log and not a part of any thread
 */
export class ChatJournalService extends Disposable implements IChatJournalService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _entries: readonly ChatJournalEntry[];
	private _dirty = false;
	private readonly _storeScheduler = this._register(new RunOnceScheduler(() => this._flush(), STORE_DEBOUNCE_MS));

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._entries = parseChatJournal(this._storageService.get(STORAGE_KEY, StorageScope.WORKSPACE), this._maxEntries());

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(CHAT_JOURNAL_MAX_ENTRIES_KEY)) { return; }
			const trimmed = trimChatJournal(this._entries, this._maxEntries());
			if (trimmed !== this._entries) { this._set(trimmed); }
		}));

		// A line written a moment before the window closes must not be lost to the debounce
		this._register(this._storageService.onWillSaveState(() => this._flush()));
		this._register(toDisposable(() => this._flush()));
	}

	get entries(): readonly ChatJournalEntry[] {
		return this._entries;
	}

	append(input: ChatJournalInput): void {
		this._set(appendChatJournalEntry(this._entries, input, Date.now(), this._maxEntries()));
	}

	markAllRead(): void {
		const read = markChatJournalRead(this._entries);
		if (read !== this._entries) { this._set(read); }
	}

	clear(): void {
		if (this._entries.length > 0) { this._set([]); }
	}

	private _maxEntries(): number {
		return chatJournalLimitOf(this._configurationService.getValue<unknown>(CHAT_JOURNAL_MAX_ENTRIES_KEY));
	}

	private _set(entries: readonly ChatJournalEntry[]): void {
		this._entries = entries;
		this._dirty = true;
		this._storeScheduler.schedule();
		this._onDidChange.fire();
	}

	private _flush(): void {
		if (!this._dirty) { return; }
		this._dirty = false;
		if (this._entries.length === 0) {
			this._storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
			return;
		}
		this._storageService.store(STORAGE_KEY, serializeChatJournal(this._entries), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

registerSingleton(IChatJournalService, ChatJournalService, InstantiationType.Delayed);
