/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

export type AgentResponseLanguage = 'auto' | 'ru' | 'en';

const VALID_LANGUAGES: readonly AgentResponseLanguage[] = ['auto', 'ru', 'en'];

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.agent',
	title: localize('vibeide.agent.title', 'Агент'),
	type: 'object',
	properties: {
		'vibeide.agent.responseLanguage': {
			type: 'string',
			enum: VALID_LANGUAGES as unknown as string[],
			enumDescriptions: [
				localize('vibeide.agent.responseLanguage.auto', 'Автоопределение по языку последнего сообщения пользователя.'),
				localize('vibeide.agent.responseLanguage.ru', 'Принудительно русский.'),
				localize('vibeide.agent.responseLanguage.en', 'Принудительно английский.'),
			],
			default: 'auto',
			description: localize('vibeide.agent.responseLanguage',
				'На каком языке агент отвечает в чате. `auto` — детект по языку последнего сообщения; `ru`/`en` — принудительно. Влияет только на текстовые ответы агента; код, имена файлов и идентификаторы команд не локализуются.'),
			scope: ConfigurationScope.RESOURCE,
		},
	},
});

const CYRILLIC_RE = /[Ѐ-ӿ]/;

/**
 * Pure helper. Resolve the response language for a single user message under the
 * current setting. Defaults: setting='auto' uses Cyrillic detection on the user
 * message (≥ 1 Cyrillic char ⇒ 'ru', otherwise 'en'). 'ru'/'en' return as-is.
 * Anything else (including unset / unknown) defaults to 'auto'-style detection.
 */
export function resolveResponseLanguage(setting: unknown, userPrompt: string): 'ru' | 'en' {
	const s = typeof setting === 'string' ? setting.toLowerCase() : '';
	if (s === 'ru' || s === 'en') {
		return s;
	}
	// auto / anything else
	return CYRILLIC_RE.test(userPrompt) ? 'ru' : 'en';
}

/**
 * Pure helper. Produce a system-prompt fragment that pins the agent's response
 * language. Caller appends the result to the existing system prompt. Empty when
 * `auto` resolves the same as the user's natural language (we trust the model
 * to mirror the user) — only emit when the policy diverges.
 */
export function buildResponseLanguageDirective(
	setting: unknown,
	userPrompt: string,
): string {
	const language = resolveResponseLanguage(setting, userPrompt);
	const s = typeof setting === 'string' ? setting.toLowerCase() : '';
	if (s === 'auto' || s === '' || !VALID_LANGUAGES.includes(s as AgentResponseLanguage)) {
		// Auto path: only enforce when user wrote in Cyrillic — models drift to English otherwise.
		if (language === 'ru') {
			return 'Ответ пользователю давай на русском языке. Сохраняй имена API и команды на английском.';
		}
		return '';
	}
	if (language === 'ru') {
		return 'Ответ пользователю давай на русском языке. Сохраняй имена API и команды на английском.';
	}
	return 'Reply to the user in English. Keep API names and command identifiers verbatim.';
}
