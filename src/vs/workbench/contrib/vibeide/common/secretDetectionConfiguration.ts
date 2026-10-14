/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { DEFAULT_SECRET_PATTERNS } from './secretDetection.js';
import { SECRET_DISABLED_RULES_SETTING } from './secretNotice.js';

export class SecretDetectionConfigurationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.secretDetectionConfiguration';

	constructor() {
		super();

		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

		registry.registerConfiguration({
			id: 'vibeide.secretDetection',
			title: localize('secretDetection.title', 'Обнаружение секретов'),
			type: 'object',
			properties: {
				'vibeide.secretDetection.enabled': {
					type: 'boolean',
					default: true,
					description: localize('secretDetection.enabled', 'Включить обнаружение и редактирование секретов. Когда включено — обнаруженные секреты заменяются плейсхолдерами перед отправкой в LLM и инструменты, а также маскируются при отображении в чате и markdown.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.secretDetection.mode': {
					type: 'string',
					enum: ['block', 'redact'],
					enumDescriptions: [
						localize('secretDetection.mode.block', 'Полностью блокировать отправку сообщений, содержащих секреты.'),
						localize('secretDetection.mode.redact', 'Разрешать отправку, но заменять секреты плейсхолдерами.'),
					],
					default: 'redact',
					description: localize('secretDetection.mode.description', 'Режим строгости: "block" — запрещает отправку секретов, "redact" — разрешает отправку с заменой на плейсхолдеры.'),
					scope: ConfigurationScope.APPLICATION,
				},
				[SECRET_DISABLED_RULES_SETTING]: {
					type: 'array',
					// The list comes from the rules themselves: a rule added to the detector shows up here by itself
					items: {
						type: 'string',
						enum: DEFAULT_SECRET_PATTERNS.map(pattern => pattern.id),
						enumDescriptions: DEFAULT_SECRET_PATTERNS.map(pattern => pattern.description),
					},
					uniqueItems: true,
					default: [],
					description: localize('secretDetection.disabledPatternIds', 'Встроенные правила обнаружения секретов, которые не должны срабатывать. Правило выбирается из списка, рядом написано, что оно ловит. Быстрее всего выключить его кнопкой в уведомлении «Из сообщения модели скрыто похожее на секрет».'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.secretDetection.enabledPatternIds': {
					type: 'array',
					items: {
						type: 'string',
					},
					default: [],
					description: localize('secretDetection.enabledPatternIds', 'Встроенные паттерны, выключенные по умолчанию и включённые обратно вашим решением. Сейчас такой один: `generic-token` — любая строка из 32, 40 или 64 шестнадцатеричных знаков. Он ловит настоящие секреты и столько же ненастоящих: контрольные суммы зависимостей, хеши коммитов, идентификаторы в сборочных файлах.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.secretDetection.customPatterns': {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: {
								type: 'string',
								description: localize('secretDetection.customPattern.id', 'Уникальный идентификатор паттерна.'),
							},
							name: {
								type: 'string',
								description: localize('secretDetection.customPattern.name', 'Понятное человеку имя паттерна.'),
							},
							pattern: {
								type: 'string',
								description: localize('secretDetection.customPattern.pattern', 'Regex-паттерн для обнаружения секретов. Использовать синтаксис JavaScript regex.'),
							},
							enabled: {
								type: 'boolean',
								default: true,
								description: localize('secretDetection.customPattern.enabled', 'Включён ли этот паттерн.'),
							},
							priority: {
								type: 'number',
								default: 50,
								description: localize('secretDetection.customPattern.priority', 'Приоритет (больше = проверяется раньше). Стандартные паттерны используют 50–100.'),
							},
						},
						required: ['id', 'name', 'pattern'],
					},
					default: [],
					description: localize('secretDetection.customPatterns', 'Пользовательские паттерны обнаружения секретов. Добавьте regex-паттерны для распознавания дополнительных форматов секретов.'),
					scope: ConfigurationScope.APPLICATION,
				},
			},
		});
	}
}

// Register the contribution to be initialized early
registerWorkbenchContribution2(SecretDetectionConfigurationContribution.ID, SecretDetectionConfigurationContribution, WorkbenchPhase.BlockRestore);

