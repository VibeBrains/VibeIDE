/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { normalizePath } from './worktreeRebase.js';

/**
 * Защита общих папок, принесённых в дерево роли ссылкой — чистая часть
 *
 * Ссылка на `node_modules` проекта дёшева, но папка за ней одна на всех
 * Установка пакетов в дереве роли и запись через ссылку меняли бы зависимости пользователя в основной папке,
 * то есть ровно то, от чего дерево и заводится
 */

/**
 * Подкоманды, которые меняют папку зависимостей
 * Пустая строка — менеджер без подкоманды: голый `yarn` и есть установка
 */
const MUTATING_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
	npm: new Set(['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'uninstall', 'un', 'remove', 'rm', 'r', 'prune', 'dedupe', 'rebuild', 'link']),
	pnpm: new Set(['install', 'i', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'prune', 'rebuild', 'link', 'ln']),
	yarn: new Set(['', 'install', 'add', 'upgrade', 'up', 'remove', 'link']),
	bun: new Set(['install', 'i', 'add', 'a', 'update', 'remove', 'rm', 'link']),
};

/** Обёртки, после которых идёт сама команда. */
const WRAPPERS = new Set(['sudo', 'env', 'corepack', 'command', 'exec', 'time', 'nice', 'nohup']);

/** Разделители команд оболочки: каждая часть проверяется отдельно. */
const SEGMENT_SPLIT = /&&|\|\||[;&|\n]/;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function commandName(token: string): string {
	return token.replace(/^.*[\\/]/, '').replace(/\.(cmd|exe|ps1|bat)$/i, '').toLowerCase();
}

function unquote(token: string): string {
	return token.replace(/^['"]|['"]$/g, '');
}

/**
 * Часть команды, которая поставила бы или убрала пакеты, — или `undefined`
 *
 * Подкоманда — первое слово после менеджера, не похожее на флаг
 * `npm --prefix x install` так не узнаётся: флаги со значением без знания каждого менеджера не разобрать,
 * а угадывание ошибалось бы в обе стороны
 */
export function packageInstallSegment(command: string): string | undefined {
	for (const rawSegment of command.split(SEGMENT_SPLIT)) {
		const tokens = rawSegment.trim().split(/\s+/).map(unquote).filter(Boolean);
		// Перед менеджером могут стоять переменные, обёртки и флаги обёрток — имя менеджера с `-` не начинается
		let index = 0;
		while (index < tokens.length && (ENV_ASSIGNMENT.test(tokens[index]) || WRAPPERS.has(commandName(tokens[index])) || tokens[index].startsWith('-'))) {
			index++;
		}
		const manager = tokens[index] !== undefined ? commandName(tokens[index]) : '';
		const mutating = MUTATING_SUBCOMMANDS[manager];
		if (!mutating) {
			continue;
		}
		const subcommand = tokens.slice(index + 1).find(token => !token.startsWith('-')) ?? '';
		if (mutating.has(subcommand.toLowerCase())) {
			return rawSegment.trim();
		}
	}
	return undefined;
}

/** Отказ для модели: что нельзя, почему и что делать вместо. */
export function describeSharedFolderInstall(segment: string, sharedFolders: readonly string[]): string {
	return [
		`Команда «${segment.slice(0, 120)}» отклонена: ${sharedFolders.join(', ')} в дереве роли — ссылки на общие папки проекта`,
		'Установка или удаление пакетов изменили бы зависимости пользователя в основной папке',
		'Если без этого задачу не решить — скажи об этом в ответе: зависимости поменяет человек',
		'Либо он включит режим копии (`vibeide.subagent.worktreeLinkMode`: `clone`), и у роли будет своя папка',
	].join('\n');
}

/** Отказ для модели при записи через ссылку. */
export function describeWriteThroughLink(relative: string, realTarget: string): string {
	return [
		`Путь «${relative}» ведёт по ссылке за пределы дерева роли — в ${normalizePath(realTarget)}`,
		'Запись туда изменила бы файлы пользователя в основной папке проекта, поэтому она отклонена',
		'Пиши в файлы самого дерева; если задача требует правки общей папки — скажи об этом в ответе',
	].join('\n');
}
