/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Бюджет на индекс навыков в системном промпте
 *
 * Индекс уходит в каждый запрос строкой на навык, и на большом наборе он сам раздувает тело запроса
 * Поэтому у него общий предел символов, а навыки сверх предела перечислены только именами
 * Имя навыка остаётся видно модели, и вызвать его можно так же, через `/skill:<имя>`
 */

/** Строка индекса навыков: имя (slash-id без префикса) и готовая строка для промпта */
export interface SkillsIndexEntry {
	name: string;
	line: string;
}

/** Результат раскладки индекса навыков по бюджету */
export interface SkillsIndexBudget {
	/** Строки, влезшие целиком, в исходном порядке */
	lines: string[];
	/** Имена навыков, оставшихся за бюджетом, в исходном порядке */
	namesOnly: string[];
}

/** Дефолт настройки `vibeide.skills.discoveryMaxChars`: один источник правды для схемы и сервиса */
export const SKILLS_DISCOVERY_MAX_CHARS_DEFAULT = 12000;

/**
 * Разложить строки индекса по бюджету символов
 * Строка влезает в остаток — попадает в `lines`, не влезает — её имя уходит в `namesOnly`, а обход продолжается
 * Бюджет 0 или меньше — все навыки остаются только именами
 */
export function applySkillsIndexBudget(entries: readonly SkillsIndexEntry[], maxChars: number): SkillsIndexBudget {
	const lines: string[] = [];
	const namesOnly: string[] = [];
	if (maxChars <= 0) {
		for (const entry of entries) {
			namesOnly.push(entry.name);
		}
		return { lines, namesOnly };
	}
	let remaining = maxChars;
	for (const entry of entries) {
		if (entry.line.length <= remaining) {
			lines.push(entry.line);
			remaining -= entry.line.length;
		} else {
			namesOnly.push(entry.name);
		}
	}
	return { lines, namesOnly };
}
