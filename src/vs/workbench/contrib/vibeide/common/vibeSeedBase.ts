/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { vibeLog } from './vibeLog.js';

/**
 * База слияния сидов `.vibe`: текст ревизии набора, от которой засеян файл.
 *
 * Конфликт сида — ваша копия правлена, а набор ушёл вперёд. Трёхстороннее слияние без базы невозможно:
 * не отличить «набор добавил строку» от «вы удалили строку». Журнал `.defaults.lock.json` хранит только хеши,
 * а по хешу текст не восстановить, поэтому текст ревизии кладётся рядом, на машине пользователя.
 *
 * Формат общий с VibeIDEA и описан в `seedBaseSpec.md` набора: `.vibe/local/seedBase/<путь сида от .vibe>`.
 */

/** Папка базы от `.vibe/`; `local/` — машинно-локальное, в git не попадает. */
const SEED_BASE_SEGMENTS: readonly string[] = ['local', 'seedBase'];

/** Своя защита папки: корневой `.vibe/.gitignore` старых проектов о `local/` может не знать. */
const SEED_BASE_GITIGNORE = '.gitignore';
const SEED_BASE_GITIGNORE_TEXT = '# Основа слияния сидов — машинно-локальная, в git не нужна\n*\n';

/** Тексты сравниваются и хранятся с LF: CRLF-чекаут не должен выглядеть правкой. */
function normalizeEol(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

/** Где лежит база файла сида `path` (POSIX-путь от `.vibe/`, как в манифесте набора). */
export function seedBaseUri(vibeDir: URI, path: string): URI {
	return joinPath(vibeDir, ...SEED_BASE_SEGMENTS, ...path.split('/'));
}

/** Текст базы, либо `undefined`, если её нет: проект засеян до того, как IDE начала их хранить. */
export async function readSeedBase(fileService: IFileService, vibeDir: URI, path: string): Promise<string | undefined> {
	try {
		return (await fileService.readFile(seedBaseUri(vibeDir, path))).value.toString();
	} catch {
		return undefined;
	}
}

/** У каких из `paths` база есть. */
export async function seedBasesPresent(fileService: IFileService, vibeDir: URI, paths: readonly string[]): Promise<ReadonlySet<string>> {
	const present = new Set<string>();
	for (const path of paths) {
		if (await readSeedBase(fileService, vibeDir, path) !== undefined) {
			present.add(path);
		}
	}
	return present;
}

export interface SeedBaseRecord {
	/** Путь сида от `.vibe/`. */
	readonly path: string;
	/** Текст ревизии набора, которую увидел человек или которой засеян файл. */
	readonly contents: string;
}

/**
 * Записывает базы. Лучшее усилие: база — подспорье слиянию, и её отсутствие не повод ронять засев или решение человека.
 * Файл, который уже содержит тот же текст, не переписывается: открытие проекта не должно менять время правки сотен файлов.
 * Возвращает, сколько баз записано.
 */
export async function recordSeedBases(fileService: IFileService, vibeDir: URI, records: readonly SeedBaseRecord[]): Promise<number> {
	let written = 0;
	for (const { path, contents } of records) {
		const text = normalizeEol(contents);
		try {
			if (await readSeedBase(fileService, vibeDir, path) === text) {
				continue;
			}
			await fileService.writeFile(seedBaseUri(vibeDir, path), VSBuffer.fromString(text));
			written++;
		} catch (e) {
			vibeLog.debug('vibeSeedBase', `база ${path} не записана: ${e}`);
		}
	}
	if (written > 0) {
		await ensureSeedBaseGitignore(fileService, vibeDir);
	}
	return written;
}

async function ensureSeedBaseGitignore(fileService: IFileService, vibeDir: URI): Promise<void> {
	const target = joinPath(vibeDir, ...SEED_BASE_SEGMENTS, SEED_BASE_GITIGNORE);
	try {
		if (!await fileService.exists(target)) {
			await fileService.writeFile(target, VSBuffer.fromString(SEED_BASE_GITIGNORE_TEXT));
		}
	} catch (e) {
		vibeLog.debug('vibeSeedBase', `.gitignore базы не записан: ${e}`);
	}
}

/** Файлы конфликта, разложенные по тому, чем их показывать. */
export interface SeedMergePlan<T extends { readonly path: string }> {
	/** Есть основа: слияние трёх сторон. */
	readonly threeWay: readonly T[];
	/** Основы нет: честно доступно только сравнение двух сторон, середину никто не выдумывает. */
	readonly twoWay: readonly T[];
}

export function planSeedMerge<T extends { readonly path: string }>(entries: readonly T[], basePresent: ReadonlySet<string>): SeedMergePlan<T> {
	return {
		threeWay: entries.filter(entry => basePresent.has(entry.path)),
		twoWay: entries.filter(entry => !basePresent.has(entry.path)),
	};
}
