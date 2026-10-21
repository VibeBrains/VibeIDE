/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Чтение файла в момент, когда внешний агент только объявил, что будет его править
 *
 * Читает главный процесс, а не окно: кадр вызова приходит сюда первым, а до окна идёт ещё через IPC,
 * и быстрый инструмент успевает записать файл раньше, чем окно его прочтёт
 * Чтение синхронное намеренно: порядок событий за ним — «база», затем сам кадр, и асинхронное чтение их переставило бы
 * Размер ограничен `ACP_BEFORE_MAX_BYTES`, поэтому остановка главного процесса измеряется долями миллисекунды
 */

import { readFileSync, statSync } from 'fs';
import { ACP_BEFORE_MAX_BYTES, AcpFileBefore, decodeBaseline } from '../../common/acp/acpEditBaseline.js';

/**
 * Файл как он есть сейчас: текст, «файла нет» или `undefined`, когда достоверно сказать нечего
 * (каталог, двоичный или слишком большой файл, не UTF-8, нет доступа)
 */
export function readFileBefore(path: string): AcpFileBefore | undefined {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > ACP_BEFORE_MAX_BYTES) { return undefined; }
		const text = decodeBaseline(readFileSync(path));
		return text === undefined ? undefined : { path, state: 'text', text };
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { path, state: 'absent' } : undefined;
	}
}
