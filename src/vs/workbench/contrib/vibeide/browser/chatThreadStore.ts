/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { parseThreadsFromStorage, serializeThreadsForStorage } from '../common/chatThreadSerialization.js';
import { capToolResultSizes } from '../common/chatThreadTrim.js';
import { THREAD_STORAGE_KEY } from '../common/storageKeys.js';
import { vibeLog } from '../common/vibeLog.js';
import type { ChatThreads, ThreadType } from './chatThreadService.js';

/** Что случилось с отдельными тредами при записи — сервис покажет предупреждения. */
export interface ChatThreadStoreSaveResult {
	/** Треды, у которых старые результаты инструментов пришлось ужать, чтобы уложиться в предел. */
	readonly cappedThreadIds: readonly string[];
	/** Треды, которые не уложились в предел даже после ужатия (сохранены как есть). */
	readonly oversizedThreadIds: readonly string[];
}

/** Жёсткие параметры ужатия на переполнении предела хранения треда. */
const THREAD_CAP_MAX_CHARS = 4096;
const THREAD_CAP_KEEP_RECENT = 4;

/** Имя настройки предела на один тред, в мегабайтах. */
const MAX_THREAD_STORAGE_MB_KEY = 'vibeide.chat.maxThreadStorageMB';
const DEFAULT_MAX_THREAD_STORAGE_MB = 32;

const isFileNotFound = (e: unknown): boolean =>
	e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND;

/**
 * Хранилище тредов чата: один файл на тред в `<globalStorage>/vibeide/chatThreads`.
 *
 * Раньше вся история всех проектов лежала одним значением `THREAD_STORAGE_KEY`:
 * каждое изменение сериализовало её целиком, и на большой истории рендерер падал
 * с OOM. Теперь запись трогает только изменившиеся треды, удаление — только те,
 * что этот экземпляр видел на диске и которые исчезли из состояния (треды,
 * созданные другим окном, не трогаем).
 */
export class ChatThreadStore extends Disposable {

	private readonly _dir: URI;
	/** Ссылки последних записанных (или загруженных) объектов — по ним считается diff. */
	private readonly _lastSaved = new Map<string, ThreadType>();
	/** Очередь записей: два save подряд не должны гоняться за одни и те же файлы. */
	private _queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly _fileService: IFileService,
		private readonly _profiles: IUserDataProfilesService,
		private readonly _storageService: IStorageService,
		private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._dir = joinPath(this._profiles.defaultProfile.globalStorageHome, 'vibeide', 'chatThreads');
	}

	/** Читает все треды каталога; перед этим переносит старый общий ключ, если он есть. */
	async load(): Promise<ChatThreads> {
		const leftover = await this._migrateLegacy();
		const onDisk = await this.readAllFromDisk();
		const threads: ChatThreads = leftover ? { ...leftover, ...onDisk } : onDisk;

		// Первый save после load не должен переписывать то, что только что прочитано.
		this._lastSaved.clear();
		for (const [id, thread] of Object.entries(threads)) {
			if (thread) { this._lastSaved.set(id, thread); }
		}
		return threads;
	}

	/** Все треды, лежащие на диске сейчас (без миграции и без изменения карты ссылок). */
	async readAllFromDisk(): Promise<ChatThreads> {
		const children = await this._listFiles();
		const threads: ChatThreads = {};
		for (const child of children) {
			try {
				const content = await this._fileService.readFile(child.resource);
				const id = this._idOfFile(child.name);
				const thread = parseThreadsFromStorage<ThreadType>(content.value.toString());
				if (thread && typeof thread === 'object') { threads[id] = thread; }
			} catch (e) {
				// Один повреждённый файл не должен лишать человека остальной истории.
				vibeLog.warn('chatThread', `Пропускаю повреждённый файл треда ${child.name}`, e);
			}
		}
		return threads;
	}

	private async _listFiles(): Promise<readonly { name: string; resource: URI }[]> {
		let stat;
		try {
			stat = await this._fileService.resolve(this._dir);
		} catch (e) {
			if (isFileNotFound(e)) { return []; }
			vibeLog.error('chatThread', 'Не удалось прочитать каталог тредов', e);
			return [];
		}
		if (!stat.isDirectory || !stat.children) { return []; }
		return stat.children.filter(child => child.isFile && child.name.endsWith('.json'));
	}

	private _idOfFile(name: string): string {
		const raw = name.slice(0, -'.json'.length);
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}

	/**
	 * Записывает изменившиеся треды и удаляет исчезнувшие из состояния.
	 * Ошибка одного треда не мешает остальным.
	 */
	save(threads: ChatThreads): Promise<ChatThreadStoreSaveResult> {
		const next = this._queue.then(() => this._doSave(threads));
		this._queue = next.catch(() => undefined);
		return next;
	}

	private async _doSave(threads: ChatThreads): Promise<ChatThreadStoreSaveResult> {
		const result = {
			cappedThreadIds: [] as string[],
			oversizedThreadIds: [] as string[],
		};
		await this._ensureDir();
		const maxBytes = this._maxThreadBytes();
		const present = new Set<string>();

		for (const [id, thread] of Object.entries(threads)) {
			if (!thread) { continue; }
			present.add(id);
			if (this._lastSaved.get(id) === thread) { continue; }
			try {
				let serialized = serializeThreadsForStorage(thread);
				if (serialized.length > maxBytes) {
					const capped = capToolResultSizes(thread.messages, THREAD_CAP_MAX_CHARS, THREAD_CAP_KEEP_RECENT);
					if (capped) {
						serialized = serializeThreadsForStorage({ ...thread, messages: capped.messages });
						result.cappedThreadIds.push(id);
					}
					if (serialized.length > maxBytes) {
						// Записываем всё равно: терять разговор из-за предела хуже, чем превысить предел.
						result.oversizedThreadIds.push(id);
					}
				}
				await this._writeThreadFile(id, serialized);
				this._lastSaved.set(id, thread);
			} catch (e) {
				vibeLog.error('chatThread', `Не удалось сохранить тред ${id}`, e);
			}
		}

		for (const id of [...this._lastSaved.keys()]) {
			if (present.has(id)) { continue; }
			try {
				await this._fileService.del(this._fileUri(id));
				this._lastSaved.delete(id);
			} catch (e) {
				if (isFileNotFound(e)) {
					this._lastSaved.delete(id);
				} else {
					// Оставляем в карте: следующая запись попробует удалить ещё раз.
					vibeLog.error('chatThread', `Не удалось удалить файл треда ${id}`, e);
				}
			}
		}

		return result;
	}

	/**
	 * Перенос истории из старого общего ключа. Ключ удаляется только после того,
	 * как перечитанный каталог подтвердил наличие всех тредов.
	 */
	private async _migrateLegacy(): Promise<ChatThreads | undefined> {
		const raw = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) { return undefined; }

		let legacy: ChatThreads;
		try {
			legacy = parseThreadsFromStorage<ChatThreads>(raw);
		} catch (e) {
			vibeLog.error('chatThread', 'Старое хранилище тредов повреждено — ключ оставлен как есть', e);
			return undefined;
		}
		if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
			vibeLog.error('chatThread', 'Старое хранилище тредов не похоже на набор тредов — ключ оставлен как есть');
			return undefined;
		}

		const ids = Object.keys(legacy).filter(id => !!legacy[id]);
		await this._ensureDir();
		for (const id of ids) {
			try {
				if (!(await this._fileService.exists(this._fileUri(id)))) {
					await this._writeThreadFile(id, serializeThreadsForStorage(legacy[id]));
				}
			} catch (e) {
				vibeLog.error('chatThread', `Не удалось перенести тред ${id} из старого хранилища`, e);
			}
		}

		// Перечитываем каталог (только имена файлов): содержимое прочитает load()
		// один раз — повторный разбор всех тредов на старте стоил бы памяти зря.
		const present = new Set((await this._listFiles()).map(child => this._idOfFile(child.name)));
		const missing = ids.filter(id => !present.has(id));
		if (missing.length === 0) {
			this._storageService.remove(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
			vibeLog.info('chatThread', `История чата перенесена в файлы: ${ids.length} тредов.`);
			return undefined;
		}

		// Проверка не прошла: не теряем ни старое значение, ни уже записанные файлы.
		vibeLog.error('chatThread', `Перенос истории чата неполный: ${missing.length} из ${ids.length} тредов без файла; старый ключ оставлен.`);
		return legacy;
	}

	private _fileUri(id: string): URI {
		return joinPath(this._dir, `${encodeURIComponent(id)}.json`);
	}

	private async _writeThreadFile(id: string, serialized: string): Promise<void> {
		const target = this._fileUri(id);
		const tmp = target.with({ path: `${target.path}.tmp` });
		await this._fileService.writeFile(tmp, VSBuffer.fromString(serialized));
		await this._fileService.move(tmp, target, true);
	}

	private async _ensureDir(): Promise<void> {
		try {
			await this._fileService.createFolder(this._dir);
		} catch (e) {
			vibeLog.error('chatThread', 'Не удалось создать каталог тредов', e);
		}
	}

	private _maxThreadBytes(): number {
		const value = this._configurationService.getValue<number>(MAX_THREAD_STORAGE_MB_KEY);
		const mb = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MAX_THREAD_STORAGE_MB;
		const safeMb = Math.max(1, Math.min(4096, mb));
		return safeMb * 1024 * 1024;
	}
}
