/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Registers vibeide.cost.* settings that drive `costForecastConfirm.ts`.
// Consumer: ChatThreadService._runChatAgent reads these via IConfigurationService.

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.cost',
	title: localize('vibeide.cost.title', 'VibeIDE — Управление стоимостью'),
	type: 'object',
	properties: {
		'vibeide.cost.confirmThreshold': {
			type: 'number',
			default: 0.5,
			description: localize('vibeide.cost.confirmThreshold', 'Показывать диалог подтверждения перед отправкой запроса, если предполагаемая стоимость превышает это значение в USD. 0 — подтверждать всегда; очень большое число — отключить. По умолчанию: $0.50.'),
		},
		'vibeide.cost.confirmTokenThreshold': {
			type: 'number',
			default: 50000,
			description: localize('vibeide.cost.confirmTokenThreshold', 'Показывать диалог подтверждения перед отправкой запроса, если предполагаемое число токенов превышает это значение. По умолчанию: 50 000.'),
		},
		'vibeide.cost.alwaysConfirm': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.cost.alwaysConfirm', 'Всегда показывать диалог подтверждения стоимости перед отправкой любого LLM-запроса, независимо от предполагаемой стоимости. Полезно при разработке или аудите расходов.'),
		},
	},
});
