/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Registers vibeide.acp.registryUrl — where external agents are imported from —, vibeide.acp.readJetBrainsAgents
// and vibeide.acp.embedMaxChars — how large a file may be to ride inside a prompt to an external agent.
// Consumers: the registry import service in electron-browser/acp and the agents listing and the prompt in browser/acp.

import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ConfigurationScope, IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../../nls.js';
import { ACP_REGISTRY_DEFAULT_URL } from './acpRegistry.js';
import { ACP_EMBED_MAX_CHARS_DEFAULT, ACP_EMBED_MAX_CHARS_KEY } from './acpPromptContext.js';

export const ACP_REGISTRY_URL_KEY = 'vibeide.acp.registryUrl';
export const ACP_READ_JETBRAINS_AGENTS_KEY = 'vibeide.acp.readJetBrainsAgents';

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
		[ACP_READ_JETBRAINS_AGENTS_KEY]: {
			type: 'boolean',
			default: true,
			// APPLICATION: the file lies in the home folder and starts commands, so a repository must not switch it on
			scope: ConfigurationScope.APPLICATION,
			description: localize('vibeide.acp.readJetBrainsAgents', 'Показывать внешних агентов из ~/.jetbrains/acp.json — туда их ставят VibeIDEA и IDE JetBrains. Файл только читается; команды проходят ту же проверку Config Guard, что и .vibe/agents.json. Агент с тем же id из .vibe/agents.json сильнее.'),
		},
		[ACP_EMBED_MAX_CHARS_KEY]: {
			type: 'number',
			default: ACP_EMBED_MAX_CHARS_DEFAULT,
			minimum: 0,
			scope: ConfigurationScope.APPLICATION,
			description: localize('vibeide.acp.embedMaxChars', 'Самый большой файл (в знаках), чей текст кладётся прямо в сообщение внешнему агенту. Файл побольше уходит ссылкой, и агент читает его сам. Выделенный фрагмент подчиняется тому же пределу.'),
		},
	},
});
