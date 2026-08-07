/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Standalone configuration registration for the `vibeide.agent.*` behaviour
// knobs that previously lived only via `?? false` fallbacks in three separate
// services (convertToLLMMessageService.ts / vibeTerminalOutputService.ts /
// vibeThinkingOutLoudService.ts). Surfacing them here makes the keys visible
// in Settings UI and gives the user a single «Агент» group to discover them.
//
// Mirrors the pattern of `vibeAgentResponseLanguageConfiguration.ts` — pure
// registration; service files keep their existing `getValue` calls untouched.

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { QUESTION_AUTO_CONTINUE_DEFAULT } from './agentLoopHeuristics.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.agent',
	title: localize('vibeide.agent.title', 'Агент'),
	type: 'object',
	properties: {
		'vibeide.agent.preferJsonToolArguments': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.agent.preferJsonToolArguments', 'Использовать JSON-форму аргументов tool-call вместо XML по умолчанию. Off-by-default: XML-форма даёт более читаемый transcript и стабильнее на моделях с inconsistent tool-calling.'),
		},
		'vibeide.agent.terminalOutputAwareness': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.agent.terminalOutputAwareness', 'Подмешивать stdout/stderr недавних агентских терминальных команд в LLM context, чтобы агент видел реальный вывод вместо догадок. Увеличивает потребление контекста; off-by-default.'),
		},
		'vibeide.agent.thinkingOutLoud': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.agent.thinkingOutLoud', 'Показывать промежуточные progress-сообщения агента между tool-call`ами в чате (`думаю над …`, `проверяю …`). Увеличивает «шум» в transcript`е, но даёт ощутимое чувство прогресса в долгих многошаговых задачах.'),
		},
		'vibeide.agent.runTestsAfterApply.enabled': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.agent.runTestsAfterApply.enabled', 'Автоматически запускать тестовую команду после агентского apply (catch regression сразу после правок). Off-by-default — добавляет latency на каждый apply; включать когда тесты быстрые (≤30s).'),
		},
		'vibeide.agent.runTestsAfterApply.command': {
			type: 'string',
			default: 'npm test',
			description: localize('vibeide.agent.runTestsAfterApply.command', 'Shell-команда для прогона тестов (используется только когда `runTestsAfterApply.enabled = true`). Должна быть быстрой (≤30s), иначе блокирует следующий agent step. Пример: `npm test -- --bail` для остановки на первой ошибке.'),
		},
		'vibeide.design.hook.mode': {
			type: 'string',
			enum: ['off', 'notify', 'enforceFloor'],
			enumDescriptions: [
				localize('vibeide.design.hook.mode.off', 'Выкл — страница после правок интерфейса не измеряется; детектор работает только когда его позовут инструментом `design_review`.'),
				localize('vibeide.design.hook.mode.notify', 'Сообщать (дефолт) — после хода, менявшего файлы интерфейса, страница измеряется, и сводка находок добавляется в чат. Ход завершается в любом случае.'),
				localize('vibeide.design.hook.mode.enforceFloor', 'Держать пол качества — то же измерение, но находки класса «пол» (контраст ниже нормы, зона нажатия меньше 44px, обрезанный контент, битая картинка) НЕ закрывают задачу: агент получает их и обязан исправить. Стилевые находки при этом никогда не блокируют — вкус не повод остановить работу.'),
			],
			default: 'notify',
			description: localize('vibeide.design.hook.mode', 'DESIGN-HOOK: автоматический замер страницы в превью при завершении хода, если ход менял файлы интерфейса (`.css`, `.tsx`, `.html`, …; тесты не считаются). Нужно открытое превью — без него хук молчит, а не рапортует «чисто». Находки, объявленные идентичностью проекта в `.vibe/design/design.md`, не показываются и не блокируют.'),
		},
		'vibeide.design.hook.maxAttempts': {
			type: 'number',
			default: 2,
			minimum: 1,
			maximum: 5,
			description: localize('vibeide.design.hook.maxAttempts', 'Сколько раз DESIGN-HOOK в режиме `enforceFloor` вернёт агента на доработку при находках класса «пол», прежде чем просто добавить заметку и закрыть ход (защита от цикла на неустранимом дефекте). Диапазон 1–5, дефолт 2.'),
		},
		'vibeide.agent.verifyGate.mode': {
			type: 'string',
			enum: ['off', 'warn', 'enforce'],
			enumDescriptions: [
				localize('vibeide.agent.verifyGate.mode.off', 'Выкл (дефолт) — завершение хода `vibe_complete` ничем не проверяется; сборку/тесты гоняет только модель по инструкции промпта.'),
				localize('vibeide.agent.verifyGate.mode.warn', 'Предупреждать — при завершении прогнать verify-команду; при красном результате добавить заметку в чат, но ХОД ВСЁ РАВНО завершается. Мягкий контроль без блокировки.'),
				localize('vibeide.agent.verifyGate.mode.enforce', 'Принуждать — при завершении прогнать verify-команду; красный результат НЕ закрывает задачу: агент получает вывод ошибки и обязан исправить (до `verifyGate.maxAttempts` возвратов, затем прогон останавливается и отдаётся тебе).'),
			],
			default: 'off',
			description: localize('vibeide.agent.verifyGate.mode', 'VERIFY-GATE: реальная проверка сборки/тестов при завершении агентского хода (вызов `vibe_complete`), а не только инструкция в промпте. Гейт активен только при непустом `verifyGate.command` И если ход реально менял файлы (чистое чтение/вопрос не гоняет сборку). Дефолт `off`, чтобы не тормозить быстрые правки — включайте `enforce` для строгой дисциплины «не done, пока не зелёно».'),
		},
		'vibeide.agent.verifyGate.command': {
			type: 'string',
			default: '',
			description: localize('vibeide.agent.verifyGate.command', 'Shell-команда верификации для VERIFY-GATE (тесты + сборка + линт), запускается в корне рабочей области при завершении хода. Пусто = гейт инертен (проверять нечем). Exit-код 0 = зелёно, иначе красно. Отличается от `runTestsAfterApply.command` (быстрый фидбэк после каждого apply) — здесь полная проверка перед закрытием задачи. Пример: `npm run verify`.'),
		},
		'vibeide.agent.verifyGate.maxAttempts': {
			type: 'number',
			default: 3,
			minimum: 1,
			maximum: 10,
			description: localize('vibeide.agent.verifyGate.maxAttempts', 'Сколько раз VERIFY-GATE в режиме `enforce` вернёт агента на доработку при красной verify-команде, прежде чем ОСТАНОВИТЬ прогон и отдать управление пользователю (защита от бесконечного цикла на неустранимой ошибке). Диапазон 1–10, дефолт 3.'),
		},
		'vibeide.agent.verifyGate.timeoutMs': {
			type: 'number',
			default: 300000,
			minimum: 5000,
			maximum: 1800000,
			description: localize('vibeide.agent.verifyGate.timeoutMs', 'Таймаут verify-команды VERIFY-GATE в миллисекундах. Verify обычно тяжелее быстрых post-apply тестов (сборка + полный прогон), поэтому лимит выше. По истечении команда прерывается и трактуется как непройденная. Диапазон 5000–1800000, дефолт 300000 (5 мин).'),
		},
		'vibeide.agent.allowReadOutsideWorkspace': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.agent.allowReadOutsideWorkspace', 'Разрешить read-only инструментам агента (read_file, ls_dir, grep, поиск и т.д.) читать файлы вне открытой рабочей области. On-by-default: запрет всё равно тривиально обходился через run_command + Get-Content, поэтому давал не безопасность, а трение. Выключите, чтобы жёстко ограничить чтение рамками workspace.'),
		},
		'vibeide.agent.allowWriteOutsideWorkspace': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.agent.allowWriteOutsideWorkspace', 'Разрешить изменяющим инструментам агента (edit_file, rewrite_file, create/delete, rename_symbol, extract_function, generate_tests) писать файлы вне открытой рабочей области. Off-by-default — защита от случайной записи в системные файлы и соседние проекты. Включайте осознанно.'),
		},
		'vibeide.agent.externalAccessAllowlist': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			scope: ConfigurationScope.RESOURCE,
			description: localize('vibeide.agent.externalAccessAllowlist', 'Список папок ВНЕ рабочей области, к которым агенту разрешён доступ (гранулярная альтернатива глобальному тогглу). Доступ распространяется на папку и её содержимое. Управляется командами «VibeIDE: Разрешить папку для доступа агента» / «Отозвать». Сессионные разрешения сюда не пишутся (живут до перезагрузки окна).'),
		},
		'vibeide.agent.referenceFolders': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			scope: ConfigurationScope.RESOURCE,
			markdownDescription: localize('vibeide.agent.referenceFolders', 'Папки-справочники ВНЕ рабочей области: агент может их **читать, но не изменять** — материалы, заметки, чужие репозитории, на которые вы ссылаетесь.\n\nОтличие от `vibeide.agent.externalAccessAllowlist`: тот список даёт и чтение, и запись. Здесь запись отклоняется всегда, поэтому «не трогай эту папку» перестаёт быть пожеланием в промте и становится настройкой. Доступ распространяется на папку и её содержимое.'),
		},
		'vibeide.agent.maxLoopIterations': {
			type: 'number',
			default: 0,
			minimum: 0,
			maximum: 200,
			description: localize('vibeide.agent.maxLoopIterations', 'Жёсткий потолок итераций tool-use loop в одном агентском прогоне: при достижении прогон ОБРЫВАЕТСЯ без вопроса. `0` = выкл (дефолт) — управление длиной прогона отдано мягкому `softCheckpointIterations`, который ПАУЗИТСЯ и спрашивает, а не рубит. Диапазон 0–200. Оставьте `0`, если не нужен именно жёсткий аварийный обрыв.'),
		},
		'vibeide.agent.softCheckpointIterations': {
			type: 'number',
			default: 0,
			minimum: 0,
			maximum: 500,
			description: localize('vibeide.agent.softCheckpointIterations', 'Мягкий чекпоинт: после стольких итераций tool-use loop в одном агентском прогоне агент ПАУЗИТСЯ и спросит, продолжать ли (в отличие от жёсткого `maxLoopIterations`, который просто обрывает прогон). Защита от тихого «молочения» десятков шагов. `0` = выкл (дефолт) — прогон без пауз, под стать включённому по умолчанию автопилоту; токеновый чекпоинт при этом тоже спит. Поставьте, например, 25 для контролируемого режима. После подтверждения порог сдвигается на следующий интервал.'),
		},
		'vibeide.agent.softCheckpointTokens': {
			type: 'number',
			default: 1000000,
			minimum: 0,
			maximum: 100000000,
			description: localize('vibeide.agent.softCheckpointTokens', 'Мягкий чекпоинт по токенам: когда расход за ОДИН агентский прогон превышает это число input+output токенов, агент паузится и спрашивает, продолжать ли. Работает вместе с `softCheckpointIterations` (что сработает раньше). `0` = выкл. ВАЖНО: при `softCheckpointIterations = 0` («полная автономия» / счётчик в тулбаре на ∞) токеновый чекпоинт тоже отключается — единый счётчик на `0` означает прогон без пауз. Дефолт 1 000 000.'),
		},
		'vibeide.agent.circuitBreakers.blockRun': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.agent.circuitBreakers.blockRun', 'Не запускать агента, пока сработавший защитный предохранитель («утечка секрета», «запись в закрытый путь») не снят вручную командой «VibeIDE: Предохранители агента». Проверка делается ОДИН раз, на старте прогона: эти предохранители взводятся проверками результата хода, то есть в конце прогона, — внутри уже начатой работы новый не появится, а обрыв на середине оставил бы правки применёнными наполовину. `false` = предохранитель только фиксируется в панели и журнале и ничего не останавливает.'),
		},
		'vibeide.agent.autoDowngradeThreshold': {
			type: 'number',
			default: 6,
			minimum: 0,
			maximum: 50,
			description: localize('vibeide.agent.autoDowngradeThreshold', 'Сколько подряд tool-ошибок (типа `numeric-tool-name`) на одной модели допускается, прежде чем агент принудительно переключит её на XML-fallback формат тулов. `0` = НИКОГДА не переключать — модель всегда остаётся на native function-calling (как в opencode CLI; рекомендуется для способных моделей вроде deepseek/claude/gpt). Дефолт 6. Circuit-breaker (15 подряд ошибок → стоп) не отключается этим ключом.'),
		},
		'vibeide.agent.reprobeAfterSuccesses': {
			type: 'number',
			default: 5,
			minimum: 1,
			maximum: 100,
			description: localize('vibeide.agent.reprobeAfterSuccesses', 'Через сколько успешных XML-tool-call`ов модель, переключённую в XML-fallback, повторно пробуют вернуть на native function-calling (одноразовый probe). Меньше = быстрее восстановление, больше = меньше «дёрганья». Дефолт 5, диапазон 1–100.'),
		},
		'vibeide.plans.toolDriftPause': {
			type: 'string',
			enum: ['always', 'manual-only', 'never'],
			default: 'manual-only',
			enumDescriptions: [
				localize('vibeide.plans.toolDriftPause.always', 'Паузить план при любом межклассовом расхождении инструмента с запланированными для шага.'),
				localize('vibeide.plans.toolDriftPause.manualOnly', 'Паузить только когда автопилот ВЫКЛЮЧЕН; под автопилотом — продолжать с инфо-уведомлением (иначе каждый шаг требует ручного «Возобновить»).'),
				localize('vibeide.plans.toolDriftPause.never', 'Никогда не паузить — только записывать расхождение в журнал активности.'),
			],
			description: localize('vibeide.plans.toolDriftPause', 'Когда паузить персистентный план, если агент вызывает инструмент вне списка `tools` текущего шага. Синонимы одного класса (edit_file ↔ rewrite_file, run_terminal_command ↔ run_command) расхождением НЕ считаются. Дефолт `manual-only`.'),
		},
		'vibeide.specs.driftPause': {
			type: 'string',
			enum: ['always', 'manual-only', 'never'],
			default: 'manual-only',
			enumDescriptions: [
				localize('vibeide.specs.driftPause.always', 'Паузить при любой правке файла вне области `scope` привязанной спеки.'),
				localize('vibeide.specs.driftPause.manualOnly', 'Паузить только когда автопилот ВЫКЛЮЧЕН; под автопилотом — продолжать с инфо-уведомлением.'),
				localize('vibeide.specs.driftPause.never', 'Никогда не паузить — только показывать инфо-уведомление о выходе за область.'),
			],
			description: localize('vibeide.specs.driftPause', 'Когда паузить реализацию, если тред привязан к утверждённой (`status: approved`) спеке (`boundThreadId` в её PRODUCT.md), а агент правит файл вне объявленной области `scope`. Срабатывает ТОЛЬКО при явной привязке через «Реализовать спеку» и только для edit-инструментов — обычную неспецифицированную работу не трогает. Спека без `scope` границ не задаёт (дрейфа нет). Дефолт `manual-only`.'),
		},
		'vibeide.agent.autoContinueMaxNudges': {
			type: 'number',
			default: 2,
			minimum: 0,
			maximum: 10,
			description: localize('vibeide.agent.autoContinueMaxNudges', 'Сколько раз ПОДРЯД, при ВКЛЮЧЁННОМ автопилоте, агент автоматически подтолкнёт модель продолжить, если та завершила ход обычным текстом БЕЗ вызова инструмента (частый артефакт слабых tool-calling-моделей через aggregator: проговаривают ход вместо вызова). Счётчик сбрасывается на каждом реально выполненном tool-call (прогресс), поэтому ограничивает только подряд идущие «пустые» текстовые ходы. `0` = выкл (даже под автопилотом останавливаться сразу). Без автопилота авто-подталкивания нет — агент останавливается и предлагает кнопку «Продолжить». Дефолт 2.'),
		},
		'vibeide.agent.autoContinueOnQuestion': {
			type: 'number',
			default: QUESTION_AUTO_CONTINUE_DEFAULT,
			minimum: 0,
			maximum: 10,
			description: localize('vibeide.agent.autoContinueOnQuestion', 'Автоподпин при вопросе: если при включённом автопилоте модель завершила ход ВОПРОСОМ (последний символ «?»), автоматически подтолкнуть её продолжить — пользователь в этом режиме не отвечает, и прогон иначе встаёт. Не тратит лимит `autoContinueMaxNudges` и работает даже при его значении 0. Значение — сколько вопрос-подпинов ПОДРЯД допускается (счётчик сбрасывается на каждом выполненном инструменте). `0` = без лимита (∞). Дефолт 3, диапазон 0–10. Тулбар-контрол «подпин?».'),
		},
		'vibeide.agent.scanTimeoutMs': {
			type: 'number',
			default: 10000,
			minimum: 1000,
			maximum: 120000,
			description: localize('vibeide.agent.scanTimeoutMs', 'Бюджет по времени (мс) для широких файловых сканов агента — `glob`, `search_pathnames_only`, `get_dir_tree`. Защищает Extension Host от зависания на огромном/корневом дереве: по истечении бюджета поиск возвращает частичный результат с пометкой «обрезано». Дефолт 10000 (10с), диапазон 1000–120000.'),
		},
	},
});
