/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Бюджет на файлы, на которые ссылаются правила проекта
 *
 * Блок `<referenced_files>` уходит в каждый запрос, поэтому защиты от отказа (20 файлов, 256 КБ при чтении) мало:
 * Встраивание ограничено своим бюджетом, а файлы сверх него модель получает списком путей и читает сама
 * Файл встраивается только целиком: половина документа вводит модель в заблуждение сильнее, чем ссылка на него
 */

/** Файл по ссылке из правил: относительный путь и уже прочитанное содержимое */
export interface LinkedReferenceFile {
	/** Путь, как его увидит модель (относительно корня рабочей области) */
	path: string;
	/** Содержимое, готовое к вставке в промпт */
	content: string;
}

/** Файл, который не влез в бюджет: модель прочитает его сама по пути */
export interface NotInlinedLinkedReference {
	path: string;
	/** Сколько символов файл занял бы в промпте: по нему модель видит цену чтения */
	chars: number;
}

/** Результат раскладки файлов по бюджету */
export interface LinkedReferencesBudget {
	/** Файлы, встроенные целиком, в исходном порядке */
	inlined: LinkedReferenceFile[];
	/** Файлы, оставшиеся только путями, в исходном порядке */
	notInlined: NotInlinedLinkedReference[];
}

/** Дефолт настройки `vibeide.projectRules.maxLinkedChars`: один источник правды для схемы и сервиса */
export const LINKED_REFERENCES_MAX_CHARS_DEFAULT = 20000;

/**
 * Разложить файлы по бюджету символов, не разрезая ни один
 * Файл, что не влез в остаток, уходит в `notInlined`, а обход продолжается: следующий меньший ещё может влезть
 * Бюджет 0 или меньше — не встраивается ничего
 */
export function applyLinkedReferencesBudget(files: readonly LinkedReferenceFile[], maxChars: number): LinkedReferencesBudget {
	const inlined: LinkedReferenceFile[] = [];
	const notInlined: NotInlinedLinkedReference[] = [];
	if (maxChars <= 0) {
		for (const file of files) {
			notInlined.push({ path: file.path, chars: file.content.length });
		}
		return { inlined, notInlined };
	}
	let remaining = maxChars;
	for (const file of files) {
		if (file.content.length <= remaining) {
			inlined.push(file);
			remaining -= file.content.length;
		} else {
			notInlined.push({ path: file.path, chars: file.content.length });
		}
	}
	return { inlined, notInlined };
}
