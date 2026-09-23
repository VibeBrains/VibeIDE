/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Registers vibeide.acp.registryUrl — where external agents are imported from.
// Consumer: the registry import service in electron-browser/acp.

import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ConfigurationScope, IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../../nls.js';
import { ACP_REGISTRY_DEFAULT_URL } from './acpRegistry.js';

export const ACP_REGISTRY_URL_KEY = 'vibeide.acp.registryUrl';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.acp',
	title: localize('vibeide.acp.title', 'VibeIDE — внешние агенты (ACP)'),
	type: 'object',
	properties: {
		[ACP_REGISTRY_URL_KEY]: {
			type: 'string',
			default: ACP_REGISTRY_DEFAULT_URL,
			// APPLICATION: agents are installed from this list, so a repository must not be able to point it elsewhere.
			scope: ConfigurationScope.APPLICATION,
			description: localize('vibeide.acp.registryUrl', 'Откуда брать список агентов для «Добавить из реестра ACP»: адрес файла registry.json. По умолчанию — официальный реестр; своё значение нужно для корпоративного зеркала. Только https.'),
		},
	},
});
