/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

export class VibeConfigGuardConfigurationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeConfigGuardConfiguration';

	constructor() {
		super();

		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

		registry.registerConfiguration({
			id: 'vibeide.configGuard',
			title: localize('configGuard.title', 'Защита конфигурации'),
			type: 'object',
			properties: {
				'vibeide.configGuard.enabled': {
					type: 'boolean',
					default: true,
					description: localize('configGuard.enabled', 'Статически проверять файлы «.vibe/providers.json» и «mcp.json» на небезопасные настройки (незашифрованные endpoint-ы, секреты в открытом виде, запуск удалённых скриптов и обход sandbox) при их загрузке.'),
					scope: ConfigurationScope.APPLICATION,
				},
				'vibeide.configGuard.mode': {
					type: 'string',
					enum: ['warn', 'block'],
					enumDescriptions: [
						localize('configGuard.mode.warn', 'Только предупреждать: записать находки в лог и показать уведомление, ничего не отключая.'),
						localize('configGuard.mode.block', 'Блокировать: дополнительно не активировать провайдеры и не запускать MCP-серверы с критичными находками.'),
					],
					default: 'warn',
					description: localize('configGuard.mode.description', 'Режим строгости: "warn" — только предупреждать; "block" — не активировать провайдеры / не запускать MCP-серверы, у которых найдена критичная проблема.'),
					scope: ConfigurationScope.APPLICATION,
				},
			},
		});
	}
}

// Register the contribution to be initialized early
registerWorkbenchContribution2(VibeConfigGuardConfigurationContribution.ID, VibeConfigGuardConfigurationContribution, WorkbenchPhase.BlockRestore);
