/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Как клиент представляется шлюзу opencode.ai.
 *
 * Шлюз выбирает путь обработки запроса по заголовкам `x-opencode-*` и `User-Agent: opencode/<версия>`, как это делает
 * CLI opencode (anomalyco/opencode, `session/llm.ts`). Без них запрос идёт по общему пути, и MiniMax с Qwen присылают
 * числовые имена инструментов и теряют обязательные параметры.
 *
 * Встроенный OpenCode Zen ставил эти заголовки в коде, а OpenCode Go (теперь провайдер из файла набора) — тоже.
 * Файл провайдера заголовки с динамическими значениями задать не может (сессия и запрос меняются), поэтому они
 * добавляются по адресу: любой провайдер, чей `baseURL` лежит на opencode.ai, получает их сам.
 *
 * Чистый модуль: идентификаторы приходят параметром, чтобы проверка не зависела от процесса.
 */

/** Хост шлюза: на нём живут и Zen (`/zen/v1`), и Go (`/zen/go/v1`). */
const OPENCODE_GATEWAY_HOST = 'opencode.ai';

/** Версия, под которой клиент называется шлюзу. Она не про наш продукт: так выглядит CLI, чьи пути обработки включены. */
const OPENCODE_CLIENT_USER_AGENT = 'opencode/0.13.0';

/** Честное имя клиента: заголовок `x-opencode-client`. */
const OPENCODE_CLIENT_NAME = 'vibeide';

export interface OpencodeGatewayIds {
	/** Один на процесс: шлюз группирует по нему запросы одного проекта. */
	readonly project: string;
	/** Один на процесс: основа липкой маршрутизации. */
	readonly session: string;
	/** Свой у каждого запроса. */
	readonly request: string;
}

/** Адрес на шлюзе opencode.ai: по нему провайдеру из файла добавляются заголовки клиента. */
export function isOpencodeGatewayUrl(baseURL: string | undefined): boolean {
	if (!baseURL) {
		return false;
	}
	try {
		return new URL(baseURL).hostname === OPENCODE_GATEWAY_HOST;
	} catch {
		return false;
	}
}

export function opencodeGatewayHeaders(ids: OpencodeGatewayIds): Record<string, string> {
	return {
		'User-Agent': OPENCODE_CLIENT_USER_AGENT,
		'x-opencode-client': OPENCODE_CLIENT_NAME,
		'x-opencode-project': ids.project,
		'x-opencode-session': ids.session,
		'x-opencode-request': ids.request,
	};
}
