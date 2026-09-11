/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Chat-input slash commands (pure helpers, no DI, no I/O). Two kinds, handled at two points:
 *
 * - **Commands the IDE runs itself** (`CHAT_SLASH_COMMANDS`: `/watch`, `/shot`). SidebarChat parses
 *   them BEFORE sending and handles them as side-effects instead of routing the literal text to the
 *   model (`parseChatSlashCommand`).
 * - **Commands that are prompts** (`PROMPT_SLASH_COMMAND_NAMES`, `/my:<name>`, `/workflow:<name>`).
 *   They go to the model: the message keeps what the person typed, and the request builder expands
 *   the command into the user turn, the same way it expands `/skill:` (`parsePromptSlashInvocation`).
 *
 * `/commit` used to sit in the first list with no handler, so it reached the model as bare text and
 * did nothing; it is a prompt now. Format and behaviour: docs/manuals/chatCommandsSpec.md.
 */

export type ChatSlashCommandName = 'watch' | 'shot';

export interface ChatSlashCommandParsed {
	readonly command: ChatSlashCommandName;
	readonly args: string;
}

export type ChatSlashCommandParseResult =
	| { readonly matched: true; readonly parsed: ChatSlashCommandParsed }
	| { readonly matched: false };

const KNOWN_COMMANDS: ReadonlySet<ChatSlashCommandName> = new Set(['watch', 'shot']);

const SLASH_LEADER_RE = /^\s*\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]+))?$/i;

/**
 * Parse the user's chat input. Returns `{ matched: true, parsed }` when the text starts with a
 * command the IDE runs itself; otherwise `{ matched: false }`.
 */
export function parseChatSlashCommand(text: string): ChatSlashCommandParseResult {
	if (typeof text !== 'string') { return { matched: false }; }
	const m = SLASH_LEADER_RE.exec(text);
	if (!m) { return { matched: false }; }
	const name = m[1].toLowerCase();
	if (!KNOWN_COMMANDS.has(name as ChatSlashCommandName)) { return { matched: false }; }
	return { matched: true, parsed: { command: name as ChatSlashCommandName, args: (m[2] ?? '').trim() } };
}

/**
 * Split `/watch` args into the video target (first token; double quotes allow spaces in
 * local paths) and the optional user question that follows.
 * `/watch "D:\мои видео\созвон.mp4" где обсуждали дедлайн` →
 * `{ target: 'D:\мои видео\созвон.mp4', hint: 'где обсуждали дедлайн' }`.
 */
export function splitWatchArgs(args: string): { readonly target: string; readonly hint: string } {
	const trimmed = args.trim();
	const quoted = /^"([^"]+)"\s*([\s\S]*)$/.exec(trimmed);
	if (quoted) {
		return { target: quoted[1].trim(), hint: quoted[2].trim() };
	}
	const spaceIdx = trimmed.search(/\s/);
	if (spaceIdx === -1) {
		return { target: trimmed, hint: '' };
	}
	return { target: trimmed.slice(0, spaceIdx), hint: trimmed.slice(spaceIdx + 1).trim() };
}

/**
 * Built-in commands that are prompts for the model. The one list of their names: the command service
 * keys its templates by it (a name without a template does not compile), and the chat input builds its
 * menu and highlighting from it.
 */
export const PROMPT_SLASH_COMMAND_NAMES = ['fix', 'tests', 'explain', 'refactor', 'review', 'docs', 'simplify', 'commit'] as const;

export type PromptSlashCommandName = typeof PROMPT_SLASH_COMMAND_NAMES[number];

/**
 * Characters of a name after `/my:` or `/workflow:` — the file name without its extension — for use
 * inside a `[…]` class of a regex with the `u` flag (the hyphen is escaped, so the class may hold more).
 * Letters of any alphabet, digits, `_`, `.`, `-`: a space would end the command, so a file whose name
 * has one cannot be invoked.
 */
export const SLASH_COMMAND_FILE_NAME_CHARS = '\\p{L}\\p{N}_.\\-';

const FILE_NAME_RE = new RegExp(`^[${SLASH_COMMAND_FILE_NAME_CHARS}]+$`, 'u');

/** Whether a prompt or workflow file name can follow `/my:` or `/workflow:`. */
export function isSlashCommandFileName(name: string): boolean {
	return FILE_NAME_RE.test(name);
}

export interface PromptSlashInvocation {
	/** `simplify`, `my:review`, `workflow:release` — without the leading slash. */
	readonly command: string;
	/** Everything after the command, trimmed; may span lines. */
	readonly args: string;
}

const PROMPT_LEADER_RE = new RegExp(`^\\s*\\/((?:my|workflow):[${SLASH_COMMAND_FILE_NAME_CHARS}]+|[a-z][a-z0-9_-]*)(?:\\s+([\\s\\S]*))?$`, 'iu');

/**
 * The prompt command a message starts with, or undefined. Only at the very start, as with the commands
 * the IDE runs: mid-sentence, `/docs` is a path, not a request. `/skill:` is not one of these — it works
 * anywhere in a message and is expanded on its own.
 */
export function parsePromptSlashInvocation(text: string): PromptSlashInvocation | undefined {
	if (typeof text !== 'string') { return undefined; }
	const m = PROMPT_LEADER_RE.exec(text);
	if (!m) { return undefined; }
	const token = m[1];
	const args = (m[2] ?? '').trim();
	const colon = token.indexOf(':');
	if (colon > 0) {
		// The namespace is ours and case-insensitive; the name is a file name and stays as typed.
		return { command: `${token.slice(0, colon).toLowerCase()}:${token.slice(colon + 1)}`, args };
	}
	const name = token.toLowerCase();
	return (PROMPT_SLASH_COMMAND_NAMES as readonly string[]).includes(name) ? { command: name, args } : undefined;
}

/**
 * Compact catalog for the hint-row UI (analog of `quickEditSlashHintNames`) — the commands the IDE runs
 * itself. Each entry's `description` is shown when the user hovers the chip; `argsHint` renders greyed
 * after the name in the autocomplete list.
 */
export const CHAT_SLASH_COMMANDS: ReadonlyArray<{
	readonly name: ChatSlashCommandName;
	readonly description: string;
	readonly argsHint?: string;
}> = [
		{ name: 'watch', description: 'Посмотреть видео целиком: кадры по сменам сцен + транскрипт → разбор с тайм-кодами', argsHint: '<ссылка или путь> [вопрос]' },
		{ name: 'shot', description: 'Снимок открытого превью картинкой в чат — показать глазами вместо описания словами' },
	];

// `/skill:` where it starts a word; a command of either kind only at the start of the message.
const COMMAND_SPAN_SOURCE = `(^|\\s)(\\/skill:[\\w.-]+)|^(\\s*)(\\/(?:${[...CHAT_SLASH_COMMANDS.map(c => c.name), ...PROMPT_SLASH_COMMAND_NAMES].join('|')})\\b|\\/(?:my|workflow):[${SLASH_COMMAND_FILE_NAME_CHARS}]+)`;

/**
 * Where the chat marks commands — in the message view and in the input overlay alike: `/skill:<name>`
 * where it starts a word (it works anywhere in a message), and a command of either kind only at the
 * very start of the message, where it works; mid-sentence, `/docs` is a path. Built from the catalogs
 * above, so the highlighting never promises a command that does not parse.
 */
export function findChatCommandSpans(text: string): Array<{ readonly start: number; readonly end: number }> {
	const spans: Array<{ readonly start: number; readonly end: number }> = [];
	const re = new RegExp(COMMAND_SPAN_SOURCE, 'gu');
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const start = m.index + (m[1] ?? m[3] ?? '').length;
		spans.push({ start, end: start + (m[2] ?? m[4]).length });
	}
	return spans;
}
