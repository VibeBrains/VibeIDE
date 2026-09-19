/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * Путь вызова инструмента — или отказ, который называет себя.
 *
 * Параметры инструмента доезжают до потребителей через приведение типа (`params as
 * BuiltinToolCallParams['read_file']`), потому что разбор возвращает объединение всех форм. Ценой
 * этого компилятор перестаёт отвечать за поле: отсутствующий `uri` превращается в
 * `Cannot read properties of undefined (reading 'fsPath')` — сообщение, по которому не найти ни
 * инструмента, ни вызова, ни места.
 *
 * Здесь та же проверка делается руками и один раз: в отказе стоит имя инструмента и ключи, которые
 * пришли на самом деле, — по такой строке место находится с первого раза.
 */
export function toolParamUri(toolName: string, params: unknown): URI {
	const uri = (params as { uri?: unknown } | undefined | null)?.uri;
	if (uri instanceof URI) {
		return uri;
	}
	const keys = params && typeof params === 'object' ? Object.keys(params as Record<string, unknown>) : [];
	const got = uri === undefined ? 'поля нет'
		: uri === null ? 'null'
			: `${typeof uri}`;
	throw new Error(`Инструмент «${toolName}» вызван без пути: параметр uri — ${got}. Пришедшие поля: ${keys.length ? keys.join(', ') : '(ни одного)'}.`);
}
