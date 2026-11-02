/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileOperation, IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IUserDataProfile, IUserDataProfilesService } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { ChatThreadStore } from '../../browser/chatThreadStore.js';
import type { ChatThreads, ThreadType } from '../../browser/chatThreadService.js';
import { serializeThreadsForStorage } from '../../common/chatThreadSerialization.js';
import { THREAD_STORAGE_KEY } from '../../common/storageKeys.js';
import { vibeLog } from '../../common/vibeLog.js';

const GLOBAL_STORAGE = URI.file('/globalStorage');
const THREADS_DIR = URI.joinPath(GLOBAL_STORAGE, 'vibeide', 'chatThreads');

class StubProfiles extends mock<IUserDataProfilesService>() {
	override readonly defaultProfile = { globalStorageHome: GLOBAL_STORAGE } as IUserDataProfile;
}

const thread = (id: string, text = `тред ${id}`): ThreadType => ({
	id,
	createdAt: '2026-01-01T00:00:00.000Z',
	lastModified: '2026-01-01T00:00:00.000Z',
	messages: [{ role: 'user', content: text, displayContent: text }],
} as unknown as ThreadType);

suite('ChatThreadStore — файл на тред', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	// Хранилище пишет в vibeLog (переходит в console.*), а раннер падает на любом выводе в консоль
	setup(() => vibeLog.configure({ enabled: false }));
	teardown(() => vibeLog.configure({ enabled: true }));

	function createStore(configuration: Record<string, unknown> = {}) {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const storage = disposables.add(new InMemoryStorageService());
		const config = new TestConfigurationService({ 'vibeide.chat.maxThreadStorageMB': 1, ...configuration });
		const store = disposables.add(new ChatThreadStore(fileService, new StubProfiles(), storage, config));
		return { fileService, storage, store, config };
	}

	async function filesOnDisk(fileService: IFileService): Promise<string[]> {
		try {
			const stat = await fileService.resolve(THREADS_DIR);
			return (stat.children ?? []).filter(child => child.isFile).map(child => child.name).sort();
		} catch {
			return [];
		}
	}

	function countWrites(fileService: IFileService): { count: number } {
		const counter = { count: 0 };
		disposables.add(fileService.onDidRunOperation(e => {
			if (e.operation === FileOperation.WRITE) { counter.count++; }
		}));
		return counter;
	}

	test('миграция: старый ключ с 3 тредами → 3 файла, ключ удалён', async () => {
		const { fileService, storage, store } = createStore();
		const legacy: ChatThreads = { a: thread('a'), b: thread('b'), c: thread('c') };
		storage.store(THREAD_STORAGE_KEY, serializeThreadsForStorage(legacy), StorageScope.APPLICATION, StorageTarget.USER);

		const loaded = await store.load();

		assert.deepStrictEqual(Object.keys(loaded).sort(), ['a', 'b', 'c']);
		assert.deepStrictEqual(await filesOnDisk(fileService), ['a.json', 'b.json', 'c.json']);
		assert.strictEqual(storage.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION), undefined, 'старый ключ удалён после проверки');
	});

	test('save после load не пишет ничего', async () => {
		const { fileService, storage, store } = createStore();
		storage.store(THREAD_STORAGE_KEY, serializeThreadsForStorage({ a: thread('a'), b: thread('b') }), StorageScope.APPLICATION, StorageTarget.USER);
		const loaded = await store.load();

		const writes = countWrites(fileService);
		await store.save(loaded);

		assert.strictEqual(writes.count, 0, 'загруженные объекты не переписываются');
	});

	test('изменили один тред → записан один файл', async () => {
		const { fileService, storage, store } = createStore();
		storage.store(THREAD_STORAGE_KEY, serializeThreadsForStorage({ a: thread('a'), b: thread('b') }), StorageScope.APPLICATION, StorageTarget.USER);
		const loaded = await store.load();

		const updated: ChatThreads = {
			...loaded,
			a: { ...loaded.a!, messages: [...loaded.a!.messages, { role: 'assistant', displayContent: 'ответ' }] } as unknown as ThreadType,
		};
		const writes = countWrites(fileService);
		await store.save(updated);

		assert.strictEqual(writes.count, 1, 'записан только изменённый тред');
	});

	test('исчезнувший тред удаляет файл, невиденный чужой — не трогает', async () => {
		const { fileService, storage, store } = createStore();
		storage.store(THREAD_STORAGE_KEY, serializeThreadsForStorage({ a: thread('a'), b: thread('b') }), StorageScope.APPLICATION, StorageTarget.USER);
		const loaded = await store.load();

		// Другое окно создало тред после нашей загрузки — этот экземпляр его не видел.
		await fileService.writeFile(URI.joinPath(THREADS_DIR, 'foreign.json'), VSBuffer.fromString(serializeThreadsForStorage(thread('foreign'))));

		await store.save({ a: loaded.a });

		assert.deepStrictEqual(await filesOnDisk(fileService), ['a.json', 'foreign.json']);
	});

	test('тред больше предела ужимается и возвращается в списке', async () => {
		const { fileService, store } = createStore();
		const big = 'x'.repeat(1_200_000);
		const small = (n: number) => ({ role: 'tool', content: `свежий ${n}`, result: `свежий ${n}` });
		const oversized = {
			id: 'big',
			messages: [
				// Два старых результата сверх окна keepRecent=4 — именно они ужимаются.
				{ role: 'tool', content: big, result: big },
				{ role: 'tool', content: big, result: big },
				small(1), small(2), small(3), small(4),
			],
		} as unknown as ThreadType;

		const result = await store.save({ big: oversized });

		assert.ok(result.cappedThreadIds.includes('big'), 'тред попал в список ужатых');
		const stat = await fileService.resolve(URI.joinPath(THREADS_DIR, 'big.json'));
		const content = (await fileService.readFile(stat.resource)).value.toString();
		assert.ok(content.length < 1_000_000, 'на диск ушла ужатая версия');
	});
});
