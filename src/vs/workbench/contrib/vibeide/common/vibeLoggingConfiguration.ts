/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Configuration registration for the `vibeide.logging.*` knobs that drive the
// `vibeLog` singleton (see vibeLog.ts). Pure registration — the live values are
// read and pushed into the singleton by `vibeLogConfigContribution.ts`.
//
// Mirrors the pattern of `vibeAgentBehaviorConfiguration.ts`.

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.logging',
	title: localize('vibeide.logging.title', 'Логирование'),
	type: 'object',
	properties: {
		'vibeide.logging.enabled': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.logging.enabled', 'Мастер-тумблер диагностического логирования VibeIDE в консоль DevTools. On-by-default на время разработки; выключите, чтобы заглушить весь вывод, не удаляя точки логирования из кода.'),
		},
		'vibeide.logging.level': {
			type: 'string',
			enum: ['off', 'error', 'warn', 'info', 'debug', 'trace'],
			enumDescriptions: [
				localize('vibeide.logging.level.off', 'Ничего не выводить.'),
				localize('vibeide.logging.level.error', 'Только ошибки.'),
				localize('vibeide.logging.level.warn', 'Ошибки и предупреждения.'),
				localize('vibeide.logging.level.info', 'Плюс информационные сообщения.'),
				localize('vibeide.logging.level.debug', 'Плюс отладочные/trace-строки (дефолт).'),
				localize('vibeide.logging.level.trace', 'Максимально подробно.'),
			],
			default: 'debug',
			description: localize('vibeide.logging.level', 'Порог уровня логов: off < error < warn < info < debug < trace. Строки выше выбранного уровня в консоль не попадают.'),
		},
		'vibeide.logging.categories': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize('vibeide.logging.categories', 'Allowlist категорий (блоков). Пусто = показывать все. Иначе в консоль проходят только перечисленные категории, напр. ["Tool","llmTurn"]. Имя категории — это часть префикса `[VibeIDE/<категория>]`. Поддерживается wildcard-префикс: `"chat*"` пропустит все категории, начинающиеся с `chat` (chatThread, chatThreadService, …) — удобно вместо перечисления ~150 имён.'),
		},
		'vibeide.logging.categoryLevels': {
			type: 'object',
			default: {},
			additionalProperties: {
				type: 'string',
				enum: ['off', 'error', 'warn', 'info', 'debug', 'trace'],
			},
			description: localize('vibeide.logging.categoryLevels', 'Точечный порог уровня на отдельные категории — переопределяет глобальный `level` только для перечисленных. Ключ — имя категории (часть `[VibeIDE/<категория>]`), значение — уровень. Напр. {"llmTurn":"off","Tool":"trace"} заглушит llmTurn и включит максимум для Tool, остальные категории — по глобальному уровню. Поддерживается wildcard-префикс `"chat*"` (применяется к группе категорий; при совпадении нескольких побеждает самый длинный префикс, точное имя — приоритетнее любого wildcard). Работает поверх allowlist `categories` (если он непустой, незалистенные категории всё равно не проходят).'),
		},
		'vibeide.logging.timestamps': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.logging.timestamps', 'Добавлять префикс датавремени (ДД.ММ.ГГГГ ЧЧ:мм:сс) к каждой строке лога — чтобы в скопированном консольном дампе были видны паузы между событиями (DevTools «Show timestamps» при копировании не сохраняется).'),
		},
		'vibeide.logging.bufferSize': {
			type: 'number',
			default: 500,
			minimum: 0,
			maximum: 10000,
			description: localize('vibeide.logging.bufferSize', 'Сколько последних строк лога держать в памяти для команды «VibeIDE: Скопировать недавние логи» (без захода в DevTools). `0` — отключить буфер. Дефолт 500, максимум 10000.'),
		},
		'vibeide.logging.collapseRepeats': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.logging.collapseRepeats', 'Схлопывать подряд идущие одинаковые строки лога в одну с пометкой «(повторилось ещё ×N)» — убирает спам в циклах (напр. повторные invalid_params). Выключите, чтобы видеть каждую строку.'),
		},
		'vibeide.debug.dumpFullPrompt': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.debug.dumpFullPrompt', 'Диагностика: при каждом LLM-запросе логировать ПОЛНЫЙ payload через `[VibeIDE/promptDump]` — system + по каждому сообщению role/content/reasoning/tool (секреты редактируются). Нужно для разбора зависаний reasoning-roundtrip (minimax/deepseek/kimi через openCodeGo). По умолчанию off (иначе бьёт по объёму логов и токен-бюджету DevTools). Сводка (длины + reasoningLen на сообщение) пишется ВСЕГДА, без этого флага.'),
		},
	},
});
