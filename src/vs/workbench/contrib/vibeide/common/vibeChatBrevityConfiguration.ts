/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Registration of `vibeide.chat.brevity`; the text and the parsing live in prompt/brevity.ts.
// Mirrors the pattern of `vibeAgentResponseLanguageConfiguration.ts`.

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { BREVITY_LEVELS, BREVITY_SETTING, DEFAULT_BREVITY_LEVEL } from './prompt/brevity.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.chat.brevity',
	title: localize('vibeide.chat.brevity.title', 'Чат'),
	type: 'object',
	properties: {
		[BREVITY_SETTING]: {
			type: 'string',
			enum: BREVITY_LEVELS as unknown as string[],
			enumDescriptions: [
				localize('vibeide.chat.brevity.off', 'Выключено: агент пишет обычно.'),
				localize('vibeide.chat.brevity.lite', 'Мягко: без воды, вежливостей и оговорок, предложения полные.'),
				localize('vibeide.chat.brevity.full', 'Коротко: без воды, фрагменты допустимы, без пересказа вызовов инструментов и украшений.'),
				localize('vibeide.chat.brevity.ultra', 'Предельно: как «Коротко», и каждый факт один раз, без лишних связок.'),
			],
			default: DEFAULT_BREVITY_LEVEL,
			markdownDescription: localize('vibeide.chat.brevity',
				'Краткие ответы агента: все технические факты остаются, уходит только вода. Код, коммиты, документация, предупреждения и подтверждения необратимых действий пишутся обычной речью. Меняется и в меню быстрых настроек под полем чата.'),
			scope: ConfigurationScope.APPLICATION,
		},
	},
});
