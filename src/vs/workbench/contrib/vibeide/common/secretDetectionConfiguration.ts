/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

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
				'vibeide.secretDetection.disabledPatternIds': {
					type: 'array',
					items: {
						type: 'string',
					},
					default: [],
					description: localize('secretDetection.disabledPatternIds', 'Список идентификаторов паттернов для отключения. Доступные паттерны: openai-key, anthropic-key, generic-api-key, jwt-token, bearer-token, aws-access-key, aws-secret-key, github-token, gitlab-token, google-api-key, stripe-key, password-pattern, private-key, generic-token.'),
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

