/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Пути личного слоя правил — общий контракт семейства Vibe.
 *
 * VibeMemory собирает личные правила в домашнюю папку, VibeIDE и VibeIDEA читают их оттуда.
 * Контракт записан в наборе (`.vibe-defaults/docs/personalRules.json`) и меняется только там:
 * генератор встраивает его в манифест, и пути ниже выводятся из него, а не пишутся второй копией.
 */

import { VIBE_PERSONAL_RULES_CONTRACT } from './vibeDefaultsManifest.generated.js';

/** Домашняя папка в метках источников и в ключах настроек — `~/.vibe/rules/ux.mdc` */
export const HOME_PATH_LABEL = '~';

/** Путь контракта `~/.vibe/rules` как путь от домашней папки — `.vibe/rules` */
export function homeRelativeOf(contractPath: string): string {
	return contractPath.startsWith(`${HOME_PATH_LABEL}/`) ? contractPath.slice(HOME_PATH_LABEL.length + 1) : contractPath;
}

/** Файл личных правил, который собирает VibeMemory; путь — от домашней папки */
export const PERSONAL_AGENTS_FILE_PATH = homeRelativeOf(VIBE_PERSONAL_RULES_CONTRACT.personalAgentsFile);

/** Папка личных правил, которую человек ведёт руками (`*.md`/`*.mdc`); путь — от домашней папки */
export const PERSONAL_RULES_DIR_PATH = homeRelativeOf(VIBE_PERSONAL_RULES_CONTRACT.personalRulesDir);

/** Файл правил в корне папки проекта, который VibeMemory пишет рядом с `AGENTS.md` */
export const PROJECT_LOCAL_AGENTS_FILE_NAME = VIBE_PERSONAL_RULES_CONTRACT.projectLocalAgentsFile;

/**
 * Метка источника для файла личного слоя: `~/.vibe/AGENTS.md`.
 *
 * Метка, а не абсолютный путь: домашняя папка бывает длинной и содержит имя человека, а модели
 * нужно видеть слой, а не адрес.
 */
export const personalSourceLabel = (homeRelativePath: string): string => `${HOME_PATH_LABEL}/${homeRelativePath}`;

/**
 * Строка-пояснение между слоями в собранном тексте.
 *
 * Модель видит оба слоя сразу, и без этой строки конфликт двух правил решается наугад: правило
 * проекта знает про этот репозиторий, личное — про человека, поэтому вперёд идёт проектное.
 */
export const PROJECT_RULES_WIN_NOTE = '[Выше — личные правила, ниже — правила проекта. При конфликте правило проекта сильнее личного.]';
