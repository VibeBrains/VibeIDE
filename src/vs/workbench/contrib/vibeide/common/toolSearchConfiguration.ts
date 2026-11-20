/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage } from './chatThreadServiceTypes.js';
import { DEFAULT_TOOL_SEARCH_THRESHOLD_CHARS, loadedToolNamesOf, TOOL_SEARCH_TOOL_NAME, ToolSearchMode } from './prompt/toolDeferral.js';

/** Режим отложенной загрузки схем: `auto` по порогу, `always` всё кроме ядра, `off` никогда */
export const TOOL_SEARCH_SETTING = 'vibeide.agent.toolSearch';

/** Порог в символах схем, после которого режим `auto` начинает откладывать */
export const TOOL_SEARCH_THRESHOLD_CHARS_SETTING = 'vibeide.agent.toolSearchThresholdChars';

/**
 * Режим из значения настройки
 *
 * Неизвестное значение читается как `auto`: опечатка в settings.json не должна молча выключать
 * откладывание и возвращать полумегабайтные запросы
 */
export function toolSearchModeOf(value: unknown): ToolSearchMode {
	return value === 'always' || value === 'off' ? value : 'auto';
}

/**
 * Порог из значения настройки
 *
 * Не число и не неотрицательное — значение по умолчанию: отрицательный порог откладывал бы всё
 * подряд, то есть молча превращал `auto` в `always`
 */
export function toolSearchThresholdCharsOf(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_TOOL_SEARCH_THRESHOLD_CHARS;
}

/**
 * Имена инструментов, уже загруженных в разговоре, — вход отложенной загрузки для промпта и запроса
 *
 * Загружен и вызванный инструмент, и всё, что вернул `tool_search` своим `loaded`: модель уже видела
 * их схемы, и откладывать их снова незачем. Оба места считают по одному правилу, иначе промпт и
 * список схем разошлись бы в том, что модель видит
 */
export function loadedToolNamesOfMessages(messages: readonly ChatMessage[]): string[] {
	const calls: { name: string; loadedNames?: readonly string[] }[] = [];
	for (const message of messages) {
		if (message.role !== 'tool' || message.type !== 'success') { continue; }
		const loaded = (message.result as unknown as { loaded?: unknown } | null)?.loaded;
		calls.push({
			name: message.name,
			loadedNames: message.name === TOOL_SEARCH_TOOL_NAME && Array.isArray(loaded)
				? loaded.filter((name): name is string => typeof name === 'string')
				: undefined,
		});
	}
	return [...loadedToolNamesOf(calls)];
}
