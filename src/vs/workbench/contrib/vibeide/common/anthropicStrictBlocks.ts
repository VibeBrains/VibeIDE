/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Строгое подмножество блоков содержимого для anthropic-СОВМЕСТИМЫХ апстримов.
 *
 * Настоящий Anthropic принимает типы блоков, которых совместимый прокси не знает, и отвечает на
 * незнакомый дискриминатор не игнорированием, а отказом всего запроса. Так у Claude Code 2.1.275
 * каждый запрос через прокси падал с `400 Input tag 'advisor_20260301'`, и чинили это отдельным
 * выпуском 2.1.276 (releasebot.io/updates/anthropic/claude-code). Механизм вендор не раскрыл —
 * поэтому здесь не догадка о нём, а управляемое сужение: к такому апстриму уезжает только то, что
 * описано в спецификации Messages API годами.
 *
 * Выключено по умолчанию: сужать запрос к апстриму, который и так всё принимает, значит терять
 * возможности молча. Включается причудой `anthropicStrictBlocks` у модели или провайдера.
 *
 * Отброшенные типы возвращаются списком, а не выбрасываются молча: строка в журнале — единственное,
 * по чему в следующий раз найдётся причина, если апстрим начнёт отвергать что-то новое.
 */

/** Типы блоков, которые anthropic-совместимые апстримы принимают повсеместно. */
export const ANTHROPIC_BASELINE_BLOCK_TYPES: ReadonlySet<string> = new Set([
	'text', 'image', 'document', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking',
]);

export interface StrictBlocksResult<T> {
	readonly messages: readonly T[];
	/** Типы, которые были отброшены, без повторов — для журнала. */
	readonly dropped: readonly string[];
}

/**
 * Убрать из содержимого сообщений блоки незнакомых типов.
 *
 * Сообщение со строковым содержимым не трогается: сужать нечего. Сообщение, у которого после
 * фильтра не осталось ни одного блока, сохраняется с пустым списком — решать, что делать с пустым
 * ходом, должен слой выше, а молча удалённое сообщение сдвинуло бы роли в диалоге.
 */
export function stripUnknownContentBlocks<T extends { content?: unknown }>(
	messages: readonly T[],
	allowed: ReadonlySet<string> = ANTHROPIC_BASELINE_BLOCK_TYPES,
): StrictBlocksResult<T> {
	const dropped = new Set<string>();
	const out = messages.map(message => {
		const content = message.content;
		if (!Array.isArray(content)) { return message; }
		const kept = content.filter(block => {
			const type = (block as { type?: unknown } | null)?.type;
			if (typeof type !== 'string') { return true; } // не наш случай — не трогаем
			if (allowed.has(type)) { return true; }
			dropped.add(type);
			return false;
		});
		return kept.length === content.length ? message : { ...message, content: kept };
	});
	return { messages: out, dropped: [...dropped] };
}
