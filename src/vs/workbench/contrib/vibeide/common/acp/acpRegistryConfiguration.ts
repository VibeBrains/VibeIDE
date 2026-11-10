/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Registers vibeide.acp.registryUrl — where external agents are imported from —, vibeide.acp.readJetBrainsAgents,
// vibeide.acp.ideTools — whether an external agent may ask the editor what is open —, vibeide.acp.embedMaxChars —
// how large a file may be to ride inside a prompt to an external agent — and vibeide.acp.traceFrames — whether the
// main process writes ACP frames to the log.
// Consumers: the registry import service in electron-browser/acp, the agents listing and the prompt in browser/acp,
// and the ACP host in electron-main/acp.

import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ConfigurationScope, IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../../nls.js';
import { ACP_REGISTRY_DEFAULT_URL } from './acpRegistry.js';
import { ACP_EMBED_MAX_CHARS_DEFAULT, ACP_EMBED_MAX_CHARS_KEY } from './acpPromptContext.js';
import { ACP_TRACE_FRAMES_KEY } from './acpTrace.js';

export const ACP_REGISTRY_URL_KEY = 'vibeide.acp.registryUrl';
export const ACP_READ_JETBRAINS_AGENTS_KEY = 'vibeide.acp.readJetBrainsAgents';
export const ACP_IDE_TOOLS_KEY = 'vibeide.acp.ideTools';

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
		[ACP_IDE_TOOLS_KEY]: {
			type: 'boolean',
			default: true,
			// APPLICATION: the tools hand the open file to a third-party process, so a repository must not switch them on
			scope: ConfigurationScope.APPLICATION,
			description: localize('vibeide.acp.ideTools', 'Давать внешнему агенту доступ к редактору: что открыто сейчас (файл, выделение, вкладки) и какие ошибки подчёркнуты. Сервер слушает только этот компьютер, у каждой сессии свой токен; файлы из .vibe/ignore не отдаются, ключи в тексте маскируются. Выключено — агент видит лишь то, что IDE положила в сообщение.'),
		},
		[ACP_EMBED_MAX_CHARS_KEY]: {
			type: 'number',
			default: ACP_EMBED_MAX_CHARS_DEFAULT,
			minimum: 0,
			scope: ConfigurationScope.APPLICATION,
			description: localize('vibeide.acp.embedMaxChars', 'Самый большой файл (в знаках), чей текст кладётся прямо в сообщение внешнему агенту. Файл побольше уходит ссылкой, и агент читает его сам. Выделенный фрагмент подчиняется тому же пределу.'),
		},
		[ACP_TRACE_FRAMES_KEY]: {
			type: 'boolean',
			default: false,
			// APPLICATION: журнал общий на всё приложение, и включать его из репозитория нельзя
			scope: ConfigurationScope.APPLICATION,
			description: localize('vibeide.acp.traceFrames', 'Писать кадры протокола ACP в журнал: вопросы разрешения, их отзывы, ответы и обновления вызовов (id, метод, статус, заголовок — без содержимого файлов и диффов). Нужно для разбора зависших вопросов; по умолчанию выключено, журнал пишется уровнем trace.'),
		},
	},
});
