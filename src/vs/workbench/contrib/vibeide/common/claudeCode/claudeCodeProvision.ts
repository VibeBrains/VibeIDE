/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Поставка Claude Agent SDK — чистая часть.
 *
 * SDK не входит в дистрибутив VibeIDE намеренно: пакет везёт с собой собственную копию Claude
 * Code, и её вес добавлялся бы к каждому installer и DMG ради возможности, которая нужна не
 * каждому. Вместо этого он ставится один раз в служебную папку при первом включении моста — тем
 * же приёмом, что `yt-dlp` для разбора видео и модели распознавания речи.
 *
 * Отдельно стоит сказать, чего эта установка НЕ делает: она не использует `claude`, установленный
 * у пользователя. SDK версионируется вместе со своей копией Claude Code («SDK v0.3.191 bundles
 * Claude Code v2.1.191»), и подсунуть ему чужой бинарь нельзя. Обещать «ничего лишнего не
 * скачается» было бы неправдой — вес переезжает из дистрибутива в служебную папку.
 *
 * Чистый модуль: ни файловой системы, ни процессов — проверяется из `test/common/`.
 */

import { localize } from '../../../../../nls.js';

/** Пакет, который ставим. Имя зафиксировано вендором. */
export const CLAUDE_AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** Папка внутри пользовательских данных VibeIDE, где живёт установка. */
export const CLAUDE_SDK_DIR = 'claude-agent-sdk';

/** В каком состоянии поставка. */
export type ClaudeSdkState =
	/** Не установлено — мост выключен, пока пользователь не разрешит установку. */
	| 'missing'
	/** Идёт установка. */
	| 'installing'
	/** Готово к работе. */
	| 'ready'
	/** Установка есть, но непригодна: битая, несовместимая или без entry point. */
	| 'broken';

export interface IClaudeSdkStatus {
	readonly state: ClaudeSdkState;
	/** Версия установленного пакета, когда известна. */
	readonly version?: string;
	/** Почему `broken` или почему установка не удалась — фразой для человека. */
	readonly reason?: string;
}

/**
 * Что должно лежать в служебной папке, чтобы считать установку рабочей.
 *
 * Проверяем не факт «папка существует», а наличие точки входа: прерванная установка оставляет
 * каталог с половиной дерева `node_modules`, и по одному только каталогу мост объявил бы себя
 * готовым, а упал бы на первом запросе — в момент, когда владелец уже ждёт ответа от телефона.
 */
export function sdkEntryPointPath(root: string): string {
	return `${root}/node_modules/${CLAUDE_AGENT_SDK_PACKAGE}/package.json`;
}

/**
 * Разбор `package.json` установленного пакета.
 *
 * Возвращает `undefined` на любой неожиданности вместо того, чтобы бросать: файл пишет чужой
 * установщик, и единственный разумный ответ на «там не то» — считать установку сломанной и
 * поставить заново.
 */
export function parseInstalledVersion(packageJsonText: string): string | undefined {
	try {
		const parsed = JSON.parse(packageJsonText) as { name?: unknown; version?: unknown };
		if (parsed?.name !== CLAUDE_AGENT_SDK_PACKAGE) { return undefined; }
		return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Аргументы установки.
 *
 * `--no-package-lock` и `--no-save`: служебная папка не проект, писать туда манифест незачем.
 * `--omit=dev` отсекает то, чего в рантайме не бывает нужно. Версия не пинится: пин заморозил бы
 * возможности Claude Code на дате нашего релиза, а обновляется он чаще нас.
 */
export function sdkInstallArgs(): readonly string[] {
	return ['install', CLAUDE_AGENT_SDK_PACKAGE, '--no-save', '--no-package-lock', '--omit=dev'];
}

/**
 * Что показать пользователю по текущему состоянию.
 *
 * Формулировки живут здесь, а не в сервисе, потому что состояние — это то, что человек видит и
 * по чему принимает решение: ставить, чинить или отменять.
 */
export function describeSdkStatus(status: IClaudeSdkStatus): string {
	switch (status.state) {
		case 'ready':
			return status.version
				? localize('vibeide.claudeCode.ready', "Claude Code SDK готов, версия {0}.", status.version)
				: localize('vibeide.claudeCode.readyNoVersion', "Claude Code SDK готов.");
		case 'installing':
			return localize('vibeide.claudeCode.installing', "Устанавливается Claude Code SDK — это разовая операция.");
		case 'missing':
			return localize('vibeide.claudeCode.missing', "Claude Code SDK не установлен. Мост включится после установки.");
		case 'broken':
			return status.reason
				? localize('vibeide.claudeCode.broken', "Установка Claude Code SDK непригодна: {0}", status.reason)
				: localize('vibeide.claudeCode.brokenNoReason', "Установка Claude Code SDK непригодна — переустановите.");
	}
}
