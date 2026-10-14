/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ChatJournalService } from '../../browser/chatJournalService.js';
import { CHAT_JOURNAL_MAX_ENTRIES_KEY, ChatJournalInput } from '../../common/chatJournal.js';

const info = (text: string): ChatJournalInput => ({ category: 'other', level: 'info', text });
const warning = (text: string): ChatJournalInput => ({ category: 'checks', level: 'warning', text });

suite('ChatJournalService — журнал окна', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function create(storage = disposables.add(new InMemoryStorageService()), limit?: number) {
		const configuration = new TestConfigurationService(limit === undefined ? {} : { [CHAT_JOURNAL_MAX_ENTRIES_KEY]: limit });
		return { storage, configuration, service: disposables.add(new ChatJournalService(storage, configuration)) };
	}

	test('запись, повтор подряд и прочтение будят подписчика ровно по разу', () => {
		const { service } = create();
		let changes = 0;
		disposables.add(service.onDidChange(() => changes++));

		service.append(info('a'));
		service.append(info('a'));
		service.append(warning('b'));
		service.markAllRead();
		service.markAllRead();
		service.clear();
		service.clear();

		assert.deepStrictEqual(changes, 5);
	});

	test('счётчик повтора и признак непрочитанного живут в записи', () => {
		const { service } = create();
		service.append(info('a'));
		service.append(info('a'));
		service.append(warning('b'));
		const before = service.entries.map(entry => [entry.text, entry.count, entry.read]);
		service.markAllRead();

		assert.deepStrictEqual({ before, after: service.entries.map(entry => entry.read) }, {
			before: [['a', 2, false], ['b', 1, false]],
			after: [true, true],
		});
	});

	test('журнал переживает перезагрузку окна: запись уходит в хранилище рабочей области, а не в общее', () => {
		const first = create();
		first.service.append(warning('b'));
		first.service.markAllRead();
		first.service.dispose();

		assert.deepStrictEqual({
			workspace: first.storage.get('vibeide.chatJournal', StorageScope.WORKSPACE) !== undefined,
			profile: first.storage.get('vibeide.chatJournal', StorageScope.PROFILE),
			reopened: create(first.storage).service.entries.map(entry => [entry.text, entry.read]),
		}, { workspace: true, profile: undefined, reopened: [['b', true]] });
	});

	test('очистка стирает и хранилище; испорченный текст в хранилище даёт пустой журнал', () => {
		const first = create();
		first.service.append(info('a'));
		first.service.clear();
		first.service.dispose();
		const cleared = first.storage.get('vibeide.chatJournal', StorageScope.WORKSPACE);

		const broken = disposables.add(new InMemoryStorageService());
		broken.store('vibeide.chatJournal', '{не json', StorageScope.WORKSPACE, StorageTarget.MACHINE);

		assert.deepStrictEqual({ cleared, brokenOpens: create(broken).service.entries }, { cleared: undefined, brokenOpens: [] });
	});

	test('лимит из настройки режет буфер, в том числе когда настройку уменьшили на ходу', async () => {
		const { service, configuration } = create(undefined, 20);
		for (let i = 1; i <= 15; i++) { service.append(info(`line ${i}`)); }
		const before = service.entries.length;

		await configuration.setUserConfiguration(CHAT_JOURNAL_MAX_ENTRIES_KEY, 10);
		configuration.onDidChangeConfigurationEmitter.fire({
			source: ConfigurationTarget.USER,
			affectedKeys: new Set([CHAT_JOURNAL_MAX_ENTRIES_KEY]),
			change: { keys: [CHAT_JOURNAL_MAX_ENTRIES_KEY], overrides: [] },
			affectsConfiguration: key => key === CHAT_JOURNAL_MAX_ENTRIES_KEY,
		});
		const texts = service.entries.map(entry => entry.text);

		assert.deepStrictEqual({ before, after: texts.length, first: texts[0], last: texts[texts.length - 1] }, { before: 15, after: 10, first: 'line 6', last: 'line 15' });
	});
});
