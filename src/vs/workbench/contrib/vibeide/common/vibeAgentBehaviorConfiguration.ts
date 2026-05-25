/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

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
		'vibeide.agent.maxLoopIterations': {
			type: 'number',
			default: 30,
			minimum: 0,
			maximum: 200,
			description: localize('vibeide.agent.maxLoopIterations', 'Максимум итераций tool-use loop в одном агентском прогоне. При достижении — прогон останавливается, чтобы не зациклиться. `0` = без лимита (для уверенных в себе; есть риск зацикливания и расхода токенов). Дефолт 30, диапазон 0–200. Контрол продублирован в нижней панели чата рядом с тогглом «Автопилот».'),
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
	},
});
