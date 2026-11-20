/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MCPUserStateOfName } from './vibeideSettingsTypes.js';

/**
 * Выключатель MCP-сервера для одного проекта.
 *
 * Глобальный переключатель живёт в настройках приложения и общий для всех окон, поэтому личный сервер
 * с токеном, нужный не в каждом проекте, приходилось копировать в проектный `mcp.json`. Здесь лежит
 * карта `{ [имя сервера]: boolean }`: запись сильнее глобального переключателя, а её отсутствие означает
 * «как везде». Карта хранится в рабочей области, файл `mcp.json` не меняется — формат общий с VibeIDEA.
 */

/** Ключ карты переопределений в хранилище рабочей области (`StorageScope.WORKSPACE`). */
export const MCP_WORKSPACE_OVERRIDES_KEY = 'vibeide.mcp.workspaceOverrides';

/** Переопределение включённости сервера в одном проекте: `true` — включён, `false` — выключен. */
export type MCPWorkspaceOverrideOfName = Readonly<Record<string, boolean>>;

/**
 * Разбирает сохранённую карту переопределений.
 *
 * Битая строка и чужие значения не должны ронять настройки: непонятная запись считается отсутствующей,
 * и сервер живёт по глобальному переключателю, как до появления переопределений.
 */
export function parseMcpWorkspaceOverrides(raw: string | undefined): MCPWorkspaceOverrideOfName {
	if (!raw) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return {};
		}
		const overrides: Record<string, boolean> = {};
		for (const [name, value] of Object.entries(parsed)) {
			if (typeof value === 'boolean') {
				overrides[name] = value;
			}
		}
		return overrides;
	} catch {
		return {};
	}
}

/**
 * Действующее «включён» для сервера в этом проекте: переопределение сильнее глобального переключателя.
 *
 * Нет записи в обоих местах — сервер включён: так же его читает загрузка конфига, где новый сервер
 * получает `isOn: true`. `undefined` вместо `false` в глобальном состоянии остаётся включённым.
 */
export function isMcpServerOnInProject(name: string, workspaceOverrideOfName: MCPWorkspaceOverrideOfName, userStateOfName: MCPUserStateOfName): boolean {
	const override = workspaceOverrideOfName[name];
	if (override !== undefined) {
		return override;
	}
	return userStateOfName[name]?.isOn !== false;
}

/**
 * Новая карта с изменённым переопределением; `undefined` убирает запись и возвращает «как везде».
 *
 * Возвращает новый объект, чтобы состояние сервиса менялось целиком и React видел разницу ссылок.
 */
export function withMcpWorkspaceOverride(current: MCPWorkspaceOverrideOfName, name: string, isOn: boolean | undefined): MCPWorkspaceOverrideOfName {
	const next: Record<string, boolean> = { ...current };
	if (isOn === undefined) {
		delete next[name];
	} else {
		next[name] = isOn;
	}
	return next;
}
