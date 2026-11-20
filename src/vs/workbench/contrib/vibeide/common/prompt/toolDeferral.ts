/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Отложенная загрузка схем инструментов
 *
 * Схемы всех инструментов всех MCP-серверов в каждом запросе раздувают тело до сотен килобайт,
 * а модель пользуется двумя-тремя из них
 * Поэтому сверх порога схемы уходят только у нужных инструментов, остальные перечислены блоком промпта,
 * и модель достаёт их через `tool_search`
 *
 * Модуль чистый: без настроек, транспорта и треда
 * Правило одно на всех провайдеров, и его проверяют без сервисов
 */

import { InternalToolInfo } from './prompts.js';
import { sacrificeOrder } from './toolBudget.js';

/** Когда откладывать схемы: решает настройка `vibeide.agent.toolSearch`, а не место вызова */
export type ToolSearchMode = 'auto' | 'always' | 'off';

/** Имя инструмента поиска */
export const TOOL_SEARCH_TOOL_NAME = 'tool_search';

/**
 * Порог по умолчанию в символах схем
 * Встроенные схемы в режиме агента весят около 51 тыс., поэтому без MCP откладывать нечего:
 * Лишний шаг через `tool_search` стоил бы токенов и времени без выигрыша
 */
export const DEFAULT_TOOL_SEARCH_THRESHOLD_CHARS = 60_000;

/** Сколько совпадений `tool_search` отдаёт по умолчанию */
export const TOOL_SEARCH_MAX_RESULTS_DEFAULT = 5;

/** Верхняя граница выдачи: больше двадцати инструментов за раз модель всё равно не освоит */
export const TOOL_SEARCH_MAX_RESULTS_LIMIT = 20;

/** Длина описания в выдаче: хватает, чтобы отличить похожие инструменты, и не съедает сэкономленное */
const MATCH_DESCRIPTION_MAX_CHARS = 200;

/** Очки за слово в имени инструмента или сервера: имя выбирает инструмент */
const NAME_MATCH_SCORE = 3;

/** Очки за слово в описании: описание только подтверждает догадку */
const DESCRIPTION_MATCH_SCORE = 1;

/** Префикс точного выбора имён в запросе к `tool_search` */
const SELECT_PREFIX = 'select:';

/** Разделители слов запроса: всё, что не буква и не цифра, включая подчёркивания из имён */
const QUERY_WORD_SEPARATORS = /[^\p{L}\p{N}]+/u;

/**
 * Сколько символов занимает схема инструмента в теле запроса
 * Меряется тот JSON, что уходит провайдеру: имя, описание и параметры, остальное в схеме постоянно
 */
export function toolSchemaChars(tool: InternalToolInfo): number {
	return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.params }).length;
}

/** Всё, от чего зависит разбиение */
export interface IToolDeferralOptions {
	/** Режим из настройки */
	readonly mode: ToolSearchMode;
	/** Порог в символах схем, после которого `auto` начинает откладывать */
	readonly thresholdChars: number;
	/** Имена, уже загруженные в разговоре: их схемы модель видит, откладывать их нельзя */
	readonly loadedToolNames: ReadonlySet<string>;
}

/** Итог разбиения: что уходит в запрос схемой и что только названо в промпте */
export interface IToolDeferral {
	readonly offered: InternalToolInfo[];
	readonly deferred: InternalToolInfo[];
}

/**
 * Разделить инструменты на отправляемые схемой и отложенные
 *
 * `tools` приходят без `tool_search`, его схема — `toolSearchTool`, и она встаёт в конец:
 * Поиск — выход из положения, а не первый пункт списка
 *
 * В `auto` откладывание идёт тем же порядком жертв, что и бюджет (`sacrificeOrder`)
 * Оно останавливается на первом инструменте, после которого список вместе со схемой поиска влезает в порог
 * Ядро не откладывается, даже если не влезает само: тот же принцип, что у бюджета
 */
export function partitionToolsForDeferral(
	tools: readonly InternalToolInfo[],
	builtinNames: ReadonlySet<string>,
	toolSearchTool: InternalToolInfo,
	options: IToolDeferralOptions,
): IToolDeferral {
	const everythingOffered: IToolDeferral = { offered: [...tools], deferred: [] };
	if (options.mode === 'off') {
		return everythingOffered;
	}

	const candidates = sacrificeOrder(tools, builtinNames).filter(t => !options.loadedToolNames.has(t.name));
	if (candidates.length === 0) {
		return everythingOffered;
	}

	let deferred: InternalToolInfo[] = candidates;
	if (options.mode === 'auto') {
		let offeredChars = tools.reduce((sum, t) => sum + toolSchemaChars(t), 0);
		if (offeredChars <= options.thresholdChars) {
			return everythingOffered;
		}
		const searchChars = toolSchemaChars(toolSearchTool);
		deferred = [];
		for (const candidate of candidates) {
			deferred.push(candidate);
			offeredChars -= toolSchemaChars(candidate);
			// Первый же кандидат, после которого список влезает в порог, — последний отложенный
			if (offeredChars + searchChars <= options.thresholdChars) {
				break;
			}
		}
	}

	const deferredSet = new Set(deferred);
	return {
		offered: [...tools.filter(t => !deferredSet.has(t)), toolSearchTool],
		deferred: [...deferred],
	};
}

/**
 * Блок системного промпта со списком отложенных инструментов
 * Без него модель не знает, что инструмент есть, и выдумывает имена
 * Текст для модели английский, как и остальные блоки промпта
 */
export function deferredToolsPromptBlock(deferred: readonly InternalToolInfo[]): string {
	if (deferred.length === 0) {
		return '';
	}

	const builtinNames: string[] = [];
	// Map держит порядок первого появления сервера — тот же стабильный порядок, что у жертв
	const byServer = new Map<string, string[]>();
	for (const tool of deferred) {
		if (tool.mcpServerName === undefined) {
			builtinNames.push(tool.name);
			continue;
		}
		const names = byServer.get(tool.mcpServerName) ?? [];
		names.push(tool.name);
		byServer.set(tool.mcpServerName, names);
	}

	const lines: string[] = [
		'<deferred_tools>',
		'These tools exist but their schemas are not loaded. To use one, call tool_search first: query "select:name1,name2" loads exact names, other text searches names and descriptions. Loaded tools become callable from the next step.',
	];
	if (builtinNames.length > 0) {
		lines.push(`Built-in: ${builtinNames.join(', ')}`);
	}
	for (const [serverName, names] of byServer) {
		lines.push(`MCP server ${serverName}: ${names.join(', ')}`);
	}
	lines.push('</deferred_tools>');
	return lines.join('\n');
}

/** Совпадение поиска: имя и одна фраза описания */
export interface IToolSearchMatch {
	readonly name: string;
	readonly description: string;
}

/**
 * Найти инструменты по запросу модели
 *
 * `select:` — точный список имён: модель знает, что ей нужно, и похожие подмешивать нельзя
 * Иначе поиск по словам, где имя втрое весомее описания
 * При равных очках побеждает порядок кандидатов, чтобы повторный запрос давал тот же ответ
 */
export function searchTools(query: string, candidates: readonly InternalToolInfo[], maxResults: number): IToolSearchMatch[] {
	const trimmed = query.trim();
	if (trimmed.toLowerCase().startsWith(SELECT_PREFIX)) {
		const byName = new Map(candidates.map(tool => [tool.name, tool] as const));
		return trimmed.slice(SELECT_PREFIX.length).split(',')
			.map(name => name.trim())
			.filter(name => name.length > 0)
			.map(name => byName.get(name))
			.filter((tool): tool is InternalToolInfo => tool !== undefined)
			.map(toSearchMatch);
	}

	const words = trimmed.toLowerCase().split(QUERY_WORD_SEPARATORS).filter(word => word.length > 0);
	if (words.length === 0) {
		return [];
	}

	const scored: { tool: InternalToolInfo; index: number; score: number }[] = [];
	candidates.forEach((tool, index) => {
		const name = tool.name.toLowerCase();
		const serverName = tool.mcpServerName?.toLowerCase() ?? '';
		const description = tool.description.toLowerCase();
		let score = 0;
		for (const word of words) {
			// Слово из имени не берёт ещё очко за описание: одно слово — один вес
			if (name.includes(word) || serverName.includes(word)) {
				score += NAME_MATCH_SCORE;
			} else if (description.includes(word)) {
				score += DESCRIPTION_MATCH_SCORE;
			}
		}
		if (score > 0) {
			scored.push({ tool, index, score });
		}
	});
	scored.sort((a, b) => b.score - a.score || a.index - b.index);
	return scored.slice(0, Math.max(0, maxResults)).map(entry => toSearchMatch(entry.tool));
}

/**
 * Имена инструментов, уже загруженных в разговоре
 * Вызов `tool_search` несёт в `loadedNames` то, что загрузил, а вызванный инструмент загружен по факту вызова
 * Тип сообщений треда сюда не тянется: вход готовит проводка, модуль остаётся чистым
 */
export function loadedToolNamesOf(
	toolCalls: readonly { readonly name: string; readonly loadedNames?: readonly string[] }[],
): Set<string> {
	const names = new Set<string>();
	for (const call of toolCalls) {
		if (call.name.length > 0) {
			names.add(call.name);
		}
		for (const loaded of call.loadedNames ?? []) {
			names.add(loaded);
		}
	}
	return names;
}

function toSearchMatch(tool: InternalToolInfo): IToolSearchMatch {
	return { name: tool.name, description: firstSentence(tool.description) };
}

/** Первая фраза описания: до точки с пробелом или перевода строки, с пределом длины */
function firstSentence(description: string): string {
	let end = description.length;
	const newline = description.indexOf('\n');
	if (newline >= 0) {
		end = Math.min(end, newline);
	}
	const dot = description.indexOf('. ');
	if (dot >= 0) {
		end = Math.min(end, dot);
	}
	const sentence = description.slice(0, end).trim();
	return sentence.length > MATCH_DESCRIPTION_MAX_CHARS ? sentence.slice(0, MATCH_DESCRIPTION_MAX_CHARS) : sentence;
}
