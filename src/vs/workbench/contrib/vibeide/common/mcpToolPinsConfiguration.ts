/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Registers vibeide.mcp.requireToolReapproval — whether a changed MCP tool is withheld until reviewed.
// Consumer: the MCP service in electron-browser; the pinning itself is in `mcpToolPins.ts`.

import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

export const MCP_REQUIRE_TOOL_REAPPROVAL_KEY = 'vibeide.mcp.requireToolReapproval';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.mcp',
	title: localize('vibeide.mcp.title', 'VibeIDE — MCP-серверы'),
	type: 'object',
	properties: {
		[MCP_REQUIRE_TOOL_REAPPROVAL_KEY]: {
			type: 'boolean',
			default: true,
			// APPLICATION: a repository must not be able to switch off a check that exists against servers it may bring.
			scope: ConfigurationScope.APPLICATION,
			description: localize('vibeide.mcp.requireToolReapproval', 'Если MCP-сервер изменил или добавил инструмент после одобрения, скрывать такой инструмент от агента, пока вы не посмотрите изменения. Выключение принимает любые изменения молча.'),
		},
	},
});
