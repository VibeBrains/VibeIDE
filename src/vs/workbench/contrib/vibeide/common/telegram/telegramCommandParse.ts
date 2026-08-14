/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parsing of what a bound chat typed. Pure: no IO, no services — so the whole command surface
 * is testable from `test/common/` without a running bot.
 */

/** A parsed command. `run` is also what plain text (no slash) turns into. */
export type VibeTelegramCommand =
	| { readonly kind: 'start' }
	| { readonly kind: 'help' }
	| { readonly kind: 'projects' }
	| { readonly kind: 'status' }
	| { readonly kind: 'stop' }
	| { readonly kind: 'menu' }
	| { readonly kind: 'digest' }
	| { readonly kind: 'use'; readonly project: string }
	| { readonly kind: 'run'; readonly prompt: string }
	/** Задача Claude Code вместо агента VibeIDE. */
	| { readonly kind: 'claude'; readonly prompt: string }
	/** Прервать прогон Claude Code. */
	| { readonly kind: 'claudeStop' }
	/** Состояние моста Claude Code, включая поставку SDK. */
	| { readonly kind: 'claudeStatus' }
	/** Задача внешнему агенту по ACP — тому, кого объявляет `.vibe/agents.json`. */
	| { readonly kind: 'acp'; readonly prompt: string }
	/** Прервать ход внешнего агента. */
	| { readonly kind: 'acpStop' }
	/** Кого можно позвать в этой рабочей папке. */
	| { readonly kind: 'acpAgents' }
	/** Выбрать агента реестра для этого чата. */
	| { readonly kind: 'acpUse'; readonly agent: string }
	| { readonly kind: 'empty' };

/**
 * Telegram appends `@bot_name` to commands sent in groups (`/status@my_bot`). Strip it so a
 * group chat behaves like a private one instead of silently falling through to `run`.
 */
function stripBotMention(word: string): string {
	const at = word.indexOf('@');
	return at === -1 ? word : word.slice(0, at);
}

/**
 * Turns a raw message into a command.
 *
 * Plain text becomes `run`: the common case is dictating a task, and forcing `/run` in front of
 * every phrase would make voice messages useless — a transcript never starts with a slash.
 */
export function parseTelegramCommand(rawText: string): VibeTelegramCommand {
	const text = rawText.trim();
	if (!text) {
		return { kind: 'empty' };
	}
	if (!text.startsWith('/')) {
		return { kind: 'run', prompt: text };
	}

	const firstSpace = text.search(/\s/);
	const head = stripBotMention(firstSpace === -1 ? text : text.slice(0, firstSpace)).toLowerCase();
	const rest = firstSpace === -1 ? '' : text.slice(firstSpace + 1).trim();

	switch (head) {
		case '/start': return { kind: 'start' };
		case '/help': return { kind: 'help' };
		case '/projects': return { kind: 'projects' };
		case '/status': return { kind: 'status' };
		case '/stop': return { kind: 'stop' };
		case '/menu': return { kind: 'menu' };
		case '/digest': return { kind: 'digest' };
		case '/use': return { kind: 'use', project: rest };
		case '/run': return rest ? { kind: 'run', prompt: rest } : { kind: 'empty' };
		// Claude Code — отдельный исполнитель, поэтому отдельная команда: без неё нельзя было бы
		// выбрать, кто делает задачу, а два агента в одном чате различаются только этим.
		case '/cc': return rest ? { kind: 'claude', prompt: rest } : { kind: 'empty' };
		case '/cc_stop': return { kind: 'claudeStop' };
		case '/cc_status': return { kind: 'claudeStatus' };
		// Внешний агент по ACP — третий исполнитель в том же чате. Отдельная команда по той же
		// причине, что и `/cc`: выбор исполнителя больше нигде не выражается.
		case '/acp': return rest ? { kind: 'acp', prompt: rest } : { kind: 'empty' };
		case '/acp_stop': return { kind: 'acpStop' };
		case '/acp_agents': return { kind: 'acpAgents' };
		case '/acp_use': return rest ? { kind: 'acpUse', agent: rest } : { kind: 'empty' };
		// An unknown slash-word is still a task, not an error: "/etc/hosts не читается" is a
		// sentence, and answering "unknown command" to it would be pedantic and useless.
		default: return { kind: 'run', prompt: text };
	}
}

/**
 * Picks the window a `/use <project>` refers to. Matching is case-insensitive and accepts a
 * unique prefix, because typing "buzz" on a phone is the point of the whole bridge.
 *
 * Returns the single match, or `undefined` when nothing or several things matched — an
 * ambiguous choice must be reported, never guessed.
 */
export function resolveProjectChoice<T extends { readonly projectName: string | undefined }>(
	windows: readonly T[],
	query: string,
): { readonly match: T } | { readonly ambiguous: readonly T[] } | undefined {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return undefined;
	}
	const named = windows.filter(w => !!w.projectName);
	const exact = named.filter(w => w.projectName!.toLowerCase() === needle);
	if (exact.length === 1) {
		return { match: exact[0] };
	}
	const prefix = named.filter(w => w.projectName!.toLowerCase().startsWith(needle));
	if (prefix.length === 1) {
		return { match: prefix[0] };
	}
	if (prefix.length > 1) {
		return { ambiguous: prefix };
	}
	const contains = named.filter(w => w.projectName!.toLowerCase().includes(needle));
	if (contains.length === 1) {
		return { match: contains[0] };
	}
	return contains.length > 1 ? { ambiguous: contains } : undefined;
}
