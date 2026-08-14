/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Подтверждения Claude Code с телефона — чистая часть.
 *
 * Здесь два перевода, и оба нетривиальны ровно настолько, чтобы их стоило проверять тестами:
 *
 *  1. **Нажатая кнопка → ответ SDK.** У моста три кнопки, у SDK два исхода (`allow` / `deny`).
 *     Третья кнопка, «Поправить», ложится на `deny` С ТЕКСТОМ — это не отказ, а перенаправление:
 *     документация SDK называет этот приём «suggest alternative», агент читает сообщение и меняет
 *     подход. Отправить `deny` без текста означало бы «нельзя», и агент пошёл бы искать обход
 *     вместо того, чтобы сделать то, что попросили.
 *  2. **Запрос инструмента → карточка на экране телефона.** Показывать сырой JSON нельзя: решение
 *     принимается за секунды и одной рукой, а `Bash` с командой на три экрана невозможно оценить.
 *     Поэтому у частых инструментов своя короткая форма, а у остальных — усечённый JSON.
 *
 * Чистый модуль: ни сети, ни сервисов — проверяется из `test/common/`.
 */

import { localize } from '../../../../../nls.js';

/** Что владелец нажал под карточкой. Совпадает с решениями моста. */
export type ClaudeApprovalDecision = 'approve' | 'reject' | 'amend';

/** Ответ, который ждёт `canUseTool` Claude Agent SDK. */
export type ClaudeToolPermission =
	| { readonly behavior: 'allow'; readonly updatedInput: Record<string, unknown> }
	| { readonly behavior: 'deny'; readonly message: string };

/**
 * Перевод решения в ответ SDK.
 *
 * `updatedInput` возвращается всегда, даже неизменённым: до Claude Code v2.1.207 ответ `allow`
 * без этого поля отклонялся как невалидный, и вызов инструмента падал с ошибкой валидации.
 * Поле стоит трёх слов, а его отсутствие ломает работу на старых установках.
 */
export function toolPermissionOf(
	decision: ClaudeApprovalDecision,
	input: Record<string, unknown>,
	amendText?: string,
): ClaudeToolPermission {
	if (decision === 'approve') {
		return { behavior: 'allow', updatedInput: input };
	}
	if (decision === 'amend') {
		const text = amendText?.trim();
		// Пустая правка — это всё-таки отказ, но честный: сказать агенту «сделай иначе» и не
		// сказать как значит отправить его гадать, а гадает он дорого.
		return {
			behavior: 'deny',
			message: text
				? localize('vibeide.claudeCode.amend', "Владелец отклонил это действие и просит вместо него: {0}", text)
				: localize('vibeide.claudeCode.amendEmpty', "Владелец отклонил это действие, пояснение не дано."),
		};
	}
	return { behavior: 'deny', message: localize('vibeide.claudeCode.reject', "Владелец отклонил это действие.") };
}

/** Сколько символов показываем в карточке до обрезки. Телефон, не монитор. */
const CARD_VALUE_LIMIT = 300;

const trim = (value: string, limit = CARD_VALUE_LIMIT): string =>
	value.length <= limit ? value : `${value.slice(0, limit)}…`;

const str = (input: Record<string, unknown>, key: string): string | undefined => {
	const value = input[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

/**
 * Карточка запроса для телефона.
 *
 * Частые инструменты разобраны по именам полей из документации SDK (`Bash`: `command`,
 * `description`; `Write`: `file_path`, `content`; `Edit`: `file_path`, `old_string`, `new_string`;
 * `Read`: `file_path`). Для остальных — усечённый JSON: выдумывать формат для инструмента,
 * которого мы не знаем, значит потерять то самое поле, ради которого человек и смотрит.
 */
export function renderApprovalCard(toolName: string, input: Record<string, unknown>): string {
	const head = localize('vibeide.claudeCode.cardHead', "Claude Code просит разрешение: {0}", toolName);

	if (toolName === 'Bash') {
		const command = str(input, 'command') ?? '';
		const description = str(input, 'description');
		const lines = [head, '', `\`${trim(command)}\``];
		if (description) { lines.push('', trim(description, 160)); }
		return lines.join('\n');
	}

	if (toolName === 'Write') {
		const path = str(input, 'file_path') ?? '?';
		const size = typeof input['content'] === 'string' ? (input['content'] as string).length : undefined;
		return [
			head,
			'',
			localize('vibeide.claudeCode.cardWrite', "Записать файл: {0}", path),
			size === undefined ? '' : localize('vibeide.claudeCode.cardWriteSize', "Объём: {0} символов", size),
		].filter(Boolean).join('\n');
	}

	if (toolName === 'Edit') {
		const path = str(input, 'file_path') ?? '?';
		const before = str(input, 'old_string');
		const after = str(input, 'new_string');
		return [
			head,
			'',
			localize('vibeide.claudeCode.cardEdit', "Правка файла: {0}", path),
			before ? `− ${trim(before, 160)}` : '',
			after ? `+ ${trim(after, 160)}` : '',
		].filter(Boolean).join('\n');
	}

	if (toolName === 'Read') {
		return [head, '', localize('vibeide.claudeCode.cardRead', "Прочитать файл: {0}", str(input, 'file_path') ?? '?')].join('\n');
	}

	// AskUserQuestion сюда не попадает: у него свой разбор на стороне сервиса — это вопрос
	// с вариантами, а не действие, которое разрешают или запрещают.
	let dump: string;
	try {
		dump = JSON.stringify(input, null, 1);
	} catch {
		dump = String(input);
	}
	return [head, '', `\`\`\`\n${trim(dump, 600)}\n\`\`\``].join('\n');
}

/**
 * Нужно ли вообще спрашивать владельца.
 *
 * Свой список автоодобрения мы намеренно НЕ заводим: у SDK уже есть `allowedTools` и режимы
 * разрешений, и второй механизм поверх них разошёлся бы с первым — а расхождение здесь означает
 * молча выполненное действие, о котором человека не спросили. Единственное, что решается тут, —
 * читающие инструменты можно не гонять на телефон, когда владелец так настроил.
 */
export const READ_ONLY_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite'];

export function shouldAskOwner(toolName: string, mirrorReadOnly: boolean): boolean {
	return mirrorReadOnly || !READ_ONLY_TOOLS.includes(toolName);
}
