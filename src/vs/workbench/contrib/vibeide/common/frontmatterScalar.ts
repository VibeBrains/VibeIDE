/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Разбор одного скалярного значения YAML-шапки
 *
 * Шапки правил и навыков пишут руками, поэтому значение встречается в четырёх формах:
 * строкой в двойных кавычках с экранированием, строкой в одинарных кавычках,
 * блочным скаляром `|` или `>` и без кавычек
 * Общая функция нужна, чтобы оба разборщика читали одно и то же значение одинаково
 *
 * `foldBlockLines` оставлен для каталога навыков: описание там показывается одной
 * строкой, и разница между `|` и `>` до него не доходит
 */
export function parseYamlScalar(raw: string, foldBlockLines = false): string {
	const value = raw.trim();
	const doubleQuoted = doubleQuotedValue(value);
	if (doubleQuoted !== undefined) {
		return doubleQuoted;
	}
	const singleQuoted = singleQuotedValue(value);
	if (singleQuoted !== undefined) {
		return singleQuoted;
	}
	const block = /^([|>])[+-]?[ \t]*(?:\r?\n([\s\S]*))?$/.exec(value);
	if (block) {
		const lines = (block[2] ?? '').split(/\r?\n/);
		const folded = block[1] === '>' || foldBlockLines;
		return (folded ? lines.join(' ') : lines.join('\n')).replace(/\s+$/, '');
	}
	return value;
}

/**
 * Значение целиком в двойных кавычках, иначе undefined
 * Закрывающая кавычка ищется с учётом `\"`, поэтому список `"a", "b"` остаётся списком
 */
function doubleQuotedValue(value: string): string | undefined {
	if (value.length < 2 || value[0] !== '"') {
		return undefined;
	}
	for (let i = 1; i < value.length; i++) {
		if (value[i] === '\\') {
			i++;
			continue;
		}
		if (value[i] === '"') {
			if (i !== value.length - 1) {
				return undefined;
			}
			return value.slice(1, -1).replace(/\\(["\\n])/g, (_, ch: string) => ch === 'n' ? '\n' : ch);
		}
	}
	return undefined;
}

/**
 * Значение целиком в одинарных кавычках, иначе undefined
 * Удвоенная кавычка внутри — это экранированная кавычка, а не конец значения
 */
function singleQuotedValue(value: string): string | undefined {
	if (value.length < 2 || value[0] !== '\'') {
		return undefined;
	}
	for (let i = 1; i < value.length; i++) {
		if (value[i] !== '\'') {
			continue;
		}
		if (value[i + 1] === '\'') {
			i++;
			continue;
		}
		if (i !== value.length - 1) {
			return undefined;
		}
		return value.slice(1, -1).replace(/''/g, '\'');
	}
	return undefined;
}
