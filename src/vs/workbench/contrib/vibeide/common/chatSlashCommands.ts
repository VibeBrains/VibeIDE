/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Chat-input slash commands (pure helper, no DI, no I/O). Parses the user's
 * text BEFORE sending to LLM; intercepts known commands and lets the caller
 * handle them as side-effects (toast, git operation, etc.) instead of routing
 * the literal `/commit` text to the model.
 *
 * Roadmap §"chat slash commands". Currently a small catalog — extends as new
 * commands land.
 */

export type ChatSlashCommandName = 'commit';

export interface ChatSlashCommandParsed {
	readonly command: ChatSlashCommandName;
	readonly flags: ReadonlyArray<string>;
	readonly args: string;
}

export type ChatSlashCommandParseResult =
	| { readonly matched: true; readonly parsed: ChatSlashCommandParsed }
	| { readonly matched: false };

const KNOWN_COMMANDS: ReadonlySet<ChatSlashCommandName> = new Set(['commit']);

const SLASH_LEADER_RE = /^\s*\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]+))?$/i;

/**
 * Parse the user's chat input. Returns `{ matched: true, parsed }` when the
 * text starts with a known chat slash command; otherwise `{ matched: false }`.
 *
 * Flags are extracted from `--name` tokens at the start of args (e.g.
 * `/commit --push some scope hint` → `flags=['push']`, `args='some scope hint'`).
 */
export function parseChatSlashCommand(text: string): ChatSlashCommandParseResult {
	if (typeof text !== 'string') { return { matched: false }; }
	const m = SLASH_LEADER_RE.exec(text);
	if (!m) { return { matched: false }; }
	const name = m[1].toLowerCase();
	if (!KNOWN_COMMANDS.has(name as ChatSlashCommandName)) { return { matched: false }; }

	const rest = (m[2] ?? '').trim();
	const flags: string[] = [];
	let argsStart = 0;
	const tokens = rest.length > 0 ? rest.split(/\s+/) : [];
	for (let i = 0; i < tokens.length; i += 1) {
		const tok = tokens[i];
		const flagMatch = /^--([a-z][a-z0-9-]*)$/i.exec(tok);
		if (flagMatch) {
			flags.push(flagMatch[1].toLowerCase());
			argsStart = i + 1;
		} else {
			break;
		}
	}
	const args = tokens.slice(argsStart).join(' ');
	return {
		matched: true,
		parsed: { command: name as ChatSlashCommandName, flags, args },
	};
}

/**
 * Compact catalog для hint-row UI (analog of `quickEditSlashHintNames`).
 * Each entry's `description` is shown when the user hovers the chip.
 */
export const CHAT_SLASH_COMMANDS: ReadonlyArray<{
	readonly name: ChatSlashCommandName;
	readonly description: string;
}> = [
		{ name: 'commit', description: 'Generate a Conventional Commit from staged changes' },
	];
