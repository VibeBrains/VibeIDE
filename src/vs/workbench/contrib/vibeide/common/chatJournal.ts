/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure model of the chat journal: the service lines of the IDE that are not part of the conversation
 * No `vscode` / `react` imports: the service, the panel and the tests all use these functions
 *
 * The journal is a ring buffer, oldest entry first
 * Two entries in a row that say the same thing are one entry with a counter
 * Unread is a flag on the entry, so the badge counts entries and not occurrences
 */

export const CHAT_JOURNAL_CATEGORIES = ['providers', 'keys', 'hooks', 'config', 'agents', 'checks', 'other'] as const;
export type ChatJournalCategory = typeof CHAT_JOURNAL_CATEGORIES[number];

export const CHAT_JOURNAL_LEVELS = ['info', 'warning'] as const;
export type ChatJournalLevel = typeof CHAT_JOURNAL_LEVELS[number];

/**
 * What the reader can do with an entry
 * The panel draws the label of `openSetting` and `openFile` itself, a `command` carries its own label
 * Every field is JSON, so an entry survives being stored
 */
export type ChatJournalAction =
	| { readonly kind: 'openSetting'; readonly settingId: string }
	| { readonly kind: 'openFile'; readonly resource: string }
	| { readonly kind: 'command'; readonly commandId: string; readonly label: string; readonly args?: readonly unknown[] };

export interface ChatJournalInput {
	readonly category: ChatJournalCategory;
	readonly level: ChatJournalLevel;
	readonly text: string;
	readonly actions?: readonly ChatJournalAction[];
}

export interface ChatJournalEntry extends ChatJournalInput {
	/** Grows with every new entry; a repeat keeps the id of the entry it joined */
	readonly id: number;
	/** Unix ms of the last occurrence */
	readonly at: number;
	/** How many times in a row this entry happened, 1 or more */
	readonly count: number;
	readonly read: boolean;
}

export interface ChatJournalFilter {
	/** Empty: every category */
	readonly categories: ReadonlySet<ChatJournalCategory>;
	readonly onlyWarnings: boolean;
}

export interface ChatJournalSummary {
	readonly total: number;
	readonly unread: number;
	readonly hasUnreadWarning: boolean;
}

/** An entry keeps at most this much text: a log of a failed build must not turn the stored journal into megabytes */
export const CHAT_JOURNAL_MAX_TEXT_CHARS = 4000;
/** The list shows this much of a long entry until the reader asks for the rest */
export const CHAT_JOURNAL_PREVIEW_LINES = 4;
export const CHAT_JOURNAL_PREVIEW_CHARS = 300;

export const CHAT_JOURNAL_MAX_ENTRIES_KEY = 'vibeide.chat.journal.maxEntries';
export const DEFAULT_CHAT_JOURNAL_MAX_ENTRIES = 200;
export const MIN_CHAT_JOURNAL_MAX_ENTRIES = 10;
export const MAX_CHAT_JOURNAL_MAX_ENTRIES = 2000;

/** The configured limit as a whole number inside the bounds the setting declares; anything else is the default */
export function chatJournalLimitOf(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_CHAT_JOURNAL_MAX_ENTRIES;
	}
	return Math.min(MAX_CHAT_JOURNAL_MAX_ENTRIES, Math.max(MIN_CHAT_JOURNAL_MAX_ENTRIES, Math.floor(value)));
}

/** Two inputs with the same key are the same line: they fold into one entry with a counter */
export function chatJournalKeyOf(input: ChatJournalInput): string {
	return JSON.stringify([input.category, input.level, input.text, input.actions ?? []]);
}

/** The text without the blank edges, cut to the limit with an ellipsis */
export function clipChatJournalText(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > CHAT_JOURNAL_MAX_TEXT_CHARS ? `${trimmed.slice(0, CHAT_JOURNAL_MAX_TEXT_CHARS - 1)}…` : trimmed;
}

/**
 * `entries` plus one more line
 * A line equal to the newest entry joins it: the counter grows, the time moves to now, and the entry is unread again
 * The oldest entries leave when the buffer is over `maxEntries`
 * A line without text is not an entry
 */
export function appendChatJournalEntry(entries: readonly ChatJournalEntry[], input: ChatJournalInput, now: number, maxEntries: number): readonly ChatJournalEntry[] {
	const line: ChatJournalInput = { ...input, text: clipChatJournalText(input.text) };
	if (!line.text) { return entries; }
	const last = entries[entries.length - 1];
	if (last && chatJournalKeyOf(last) === chatJournalKeyOf(line)) {
		return [...entries.slice(0, -1), { ...last, count: last.count + 1, at: now, read: false }];
	}
	const id = (last?.id ?? 0) + 1;
	const next = [...entries, { ...line, id, at: now, count: 1, read: false }];
	return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
}

/** The buffer cut to a new, smaller limit; the same array when nothing has to go */
export function trimChatJournal(entries: readonly ChatJournalEntry[], maxEntries: number): readonly ChatJournalEntry[] {
	return entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;
}

/** Every entry read; the same array when it already is, so an observer is not woken for nothing */
export function markChatJournalRead(entries: readonly ChatJournalEntry[]): readonly ChatJournalEntry[] {
	return entries.some(entry => !entry.read) ? entries.map(entry => (entry.read ? entry : { ...entry, read: true })) : entries;
}

export function summarizeChatJournal(entries: readonly ChatJournalEntry[]): ChatJournalSummary {
	let unread = 0;
	let hasUnreadWarning = false;
	for (const entry of entries) {
		if (!entry.read) {
			unread++;
			hasUnreadWarning ||= entry.level === 'warning';
		}
	}
	return { total: entries.length, unread, hasUnreadWarning };
}

/** The entries that pass the filter, the newest first */
export function filterChatJournal(entries: readonly ChatJournalEntry[], filter: ChatJournalFilter): readonly ChatJournalEntry[] {
	const out: ChatJournalEntry[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (filter.onlyWarnings && entry.level !== 'warning') { continue; }
		if (filter.categories.size > 0 && !filter.categories.has(entry.category)) { continue; }
		out.push(entry);
	}
	return out;
}

/** How many entries each category has, in the order of `CHAT_JOURNAL_CATEGORIES`; categories without entries are left out */
export function countChatJournalByCategory(entries: readonly ChatJournalEntry[]): readonly { readonly category: ChatJournalCategory; readonly count: number }[] {
	const counts = new Map<ChatJournalCategory, number>();
	for (const entry of entries) {
		counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
	}
	return CHAT_JOURNAL_CATEGORIES.filter(category => counts.has(category)).map(category => ({ category, count: counts.get(category)! }));
}

/** The head of a long text for the list; `truncated` tells the panel to offer the rest */
export function previewChatJournalText(text: string): { readonly text: string; readonly truncated: boolean } {
	const lines = text.split('\n');
	const head = lines.slice(0, CHAT_JOURNAL_PREVIEW_LINES).join('\n');
	if (lines.length <= CHAT_JOURNAL_PREVIEW_LINES && head.length <= CHAT_JOURNAL_PREVIEW_CHARS) {
		return { text, truncated: false };
	}
	return { text: head.length > CHAT_JOURNAL_PREVIEW_CHARS ? `${head.slice(0, CHAT_JOURNAL_PREVIEW_CHARS - 1)}…` : `${head}…`, truncated: true };
}

export interface ChatJournalSpan {
	readonly text: string;
	readonly style: 'plain' | 'bold' | 'code';
}

const INLINE_MARKUP = /\*\*(?<bold>[^*\n]+)\*\*|`(?<code>[^`\n]+)`/g;

/**
 * The text split into the two inline marks the sources use: `**bold**` and `` `code` ``
 * Nothing else is read as markup, so a path with an underscore or a list dash stays as written
 */
export function chatJournalSpansOf(text: string): readonly ChatJournalSpan[] {
	const spans: ChatJournalSpan[] = [];
	let from = 0;
	for (const match of text.matchAll(INLINE_MARKUP)) {
		if (match.index > from) { spans.push({ text: text.slice(from, match.index), style: 'plain' }); }
		const { bold, code } = match.groups!;
		spans.push(bold !== undefined ? { text: bold, style: 'bold' } : { text: code!, style: 'code' });
		from = match.index + match[0].length;
	}
	if (from < text.length) { spans.push({ text: text.slice(from), style: 'plain' }); }
	return spans;
}

export function serializeChatJournal(entries: readonly ChatJournalEntry[]): string {
	return JSON.stringify(entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAction(value: unknown): ChatJournalAction | undefined {
	if (!isRecord(value)) { return undefined; }
	if (value.kind === 'openSetting' && typeof value.settingId === 'string') {
		return { kind: 'openSetting', settingId: value.settingId };
	}
	if (value.kind === 'openFile' && typeof value.resource === 'string') {
		return { kind: 'openFile', resource: value.resource };
	}
	if (value.kind === 'command' && typeof value.commandId === 'string' && typeof value.label === 'string') {
		return { kind: 'command', commandId: value.commandId, label: value.label, ...(Array.isArray(value.args) ? { args: value.args } : {}) };
	}
	return undefined;
}

function parseEntry(value: unknown): ChatJournalEntry | undefined {
	if (!isRecord(value)) { return undefined; }
	const { id, at, count, read, text, category, level, actions } = value;
	if (typeof id !== 'number' || !Number.isFinite(id) || typeof at !== 'number' || !Number.isFinite(at)) { return undefined; }
	if (typeof count !== 'number' || !Number.isFinite(count) || count < 1 || typeof read !== 'boolean' || typeof text !== 'string') { return undefined; }
	if (!(CHAT_JOURNAL_CATEGORIES as readonly unknown[]).includes(category) || !(CHAT_JOURNAL_LEVELS as readonly unknown[]).includes(level)) { return undefined; }
	const parsedActions = Array.isArray(actions) ? actions.map(parseAction).filter((action): action is ChatJournalAction => !!action) : [];
	return {
		id, at, count: Math.floor(count), read, text,
		category: category as ChatJournalCategory,
		level: level as ChatJournalLevel,
		...(parsedActions.length > 0 ? { actions: parsedActions } : {}),
	};
}

/**
 * The buffer read back from storage
 * A damaged text or a damaged entry costs only itself: the journal is a convenience and must never stop the window
 */
export function parseChatJournal(raw: string | undefined, maxEntries: number): readonly ChatJournalEntry[] {
	if (!raw) { return []; }
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) { return []; }
	const entries = parsed.map(parseEntry).filter((entry): entry is ChatJournalEntry => !!entry);
	return trimChatJournal(entries, maxEntries);
}
