/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MCPConfigFileEntryJSON } from '../mcpServiceTypes.js';

/**
 * Какие MCP-серверы проекта получает гостевой ACP-агент.
 *
 * ГЛАВНОЕ ПРО МЕХАНИКУ: ACP передаёт гостю **конфигурации серверов**, а не адрес нашего шлюза
 * (`session/new` → `mcpServers`: stdio — `name/command/args/env`, HTTP — `type/name/url/headers`;
 * agentclientprotocol.com/protocol/session-setup). То есть гость подключается к серверам САМ, своим
 * клиентом. Отсюда два следствия, которые определяют правила ниже.
 *
 * Первое: наш список разрешённых инструментов (`tools` у записи сервера) на гостя **не
 * распространяется** — он живёт в нашем вызове, а гость нас не спрашивает. Поэтому сервер с таким
 * списком не экспортируется вовсе: отдать его значило бы молча снять ограничение, которое человек
 * написал руками.
 *
 * Второе: вместе с конфигурацией уезжают `env` и `headers`, а там бывают ключи. Поэтому экспорт
 * поимённый и по умолчанию пустой — «отдать всё» не предлагается даже как вариант: список,
 * который растёт сам при добавлении нового сервера в `mcp.json`, однажды увезёт гостю то, чего
 * человек не имел в виду.
 */

/** Сервер в том виде, в каком его принимает ACP. */
export type AcpMcpServer =
	| { readonly name: string; readonly command: string; readonly args: readonly string[]; readonly env: readonly { readonly name: string; readonly value: string }[] }
	| { readonly type: 'http'; readonly name: string; readonly url: string; readonly headers: readonly { readonly name: string; readonly value: string }[] };

/** Почему сервер не уехал гостю — строкой, которую можно показать человеку. */
export interface AcpMcpSkipped {
	readonly name: string;
	readonly reason: string;
}

export interface AcpMcpExportInput {
	/** Записи из `~/.vibeide/mcp.json` по именам. */
	readonly entries: Readonly<Record<string, MCPConfigFileEntryJSON>>;
	/** Имена, которые разрешил экспортировать `.vibe/agents.json`. Пусто — ничего не уезжает. */
	readonly allowed: readonly string[];
	/** Выключенные пользователем серверы: выключен здесь — выключен и у гостя. */
	readonly isEnabled: (name: string) => boolean;
}

export interface AcpMcpExportResult {
	readonly servers: readonly AcpMcpServer[];
	readonly skipped: readonly AcpMcpSkipped[];
}

const pairs = (record: Readonly<Record<string, string>> | undefined): { name: string; value: string }[] =>
	Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));

/**
 * Собрать список серверов для `session/new`.
 *
 * Пропуски не молчаливые: у каждого есть причина, и вызывающий пишет её в журнал. Гость, не
 * получивший сервер, ведёт себя как будто сервера нет, — и без строки в журнале это выглядит
 * поломкой самого гостя.
 */
export function buildAcpMcpServers(input: AcpMcpExportInput): AcpMcpExportResult {
	const servers: AcpMcpServer[] = [];
	const skipped: AcpMcpSkipped[] = [];
	for (const name of input.allowed) {
		const entry = input.entries[name];
		if (!entry) {
			skipped.push({ name, reason: 'сервера с таким именем нет в mcp.json' });
			continue;
		}
		if (!input.isEnabled(name)) {
			skipped.push({ name, reason: 'сервер выключен в настройках' });
			continue;
		}
		if (entry.tools !== undefined) {
			skipped.push({ name, reason: 'у сервера есть список разрешённых инструментов, а на гостя он не действует — экспорт снял бы ограничение молча' });
			continue;
		}
		if (entry.command) {
			servers.push({ name, command: entry.command, args: [...(entry.args ?? [])], env: pairs(entry.env) });
			continue;
		}
		if (entry.url) {
			if (entry.headersHelper) {
				// The helper's header is a credential issued to this IDE; a guest would get the server without it and fail
				skipped.push({ name, reason: 'заголовок сервера выдаёт помощник headersHelper — этот доступ выдан IDE, а не гостю' });
				continue;
			}
			if (entry.type === 'sse') {
				// SSE в ACP объявлен устаревшим; гость вправе его не поддерживать, а тихо уехавший
				// неподдержанный транспорт выглядит у него как неработающий сервер.
				skipped.push({ name, reason: 'транспорт SSE в ACP объявлен устаревшим' });
				continue;
			}
			servers.push({ type: 'http', name, url: String(entry.url), headers: pairs(entry.headers) });
			continue;
		}
		skipped.push({ name, reason: 'в записи нет ни command, ни url' });
	}
	return { servers, skipped };
}

/** True — запись описывает HTTP-сервер. Гость получает такие, только если объявил их поддержку. */
export function isHttpAcpMcpServer(server: AcpMcpServer): boolean {
	return 'type' in server && server.type === 'http';
}
