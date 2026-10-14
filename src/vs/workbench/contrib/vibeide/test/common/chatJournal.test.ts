/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	appendChatJournalEntry,
	CHAT_JOURNAL_MAX_TEXT_CHARS,
	CHAT_JOURNAL_PREVIEW_CHARS,
	chatJournalSpansOf,
	ChatJournalEntry,
	ChatJournalInput,
	chatJournalLimitOf,
	countChatJournalByCategory,
	DEFAULT_CHAT_JOURNAL_MAX_ENTRIES,
	filterChatJournal,
	markChatJournalRead,
	parseChatJournal,
	previewChatJournalText,
	serializeChatJournal,
	summarizeChatJournal,
	trimChatJournal,
} from '../../common/chatJournal.js';

const info = (text: string, category: ChatJournalInput['category'] = 'other'): ChatJournalInput => ({ category, level: 'info', text });
const warning = (text: string, category: ChatJournalInput['category'] = 'other'): ChatJournalInput => ({ category, level: 'warning', text });

/** The journal after the inputs, one tick of the clock apart, so the order of the entries is readable from `at` */
function journalOf(inputs: readonly ChatJournalInput[], maxEntries = DEFAULT_CHAT_JOURNAL_MAX_ENTRIES): readonly ChatJournalEntry[] {
	return inputs.reduce<readonly ChatJournalEntry[]>((entries, input, i) => appendChatJournalEntry(entries, input, 1000 + i, maxEntries), []);
}

suite('Chat journal — pure model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('append: a new line is unread, counted once, and gets the next id', () => {
		const entries = journalOf([info('a'), warning('b', 'checks')]);
		assert.deepStrictEqual(entries, [
			{ category: 'other', level: 'info', text: 'a', id: 1, at: 1000, count: 1, read: false },
			{ category: 'checks', level: 'warning', text: 'b', id: 2, at: 1001, count: 1, read: false },
		]);
	});

	test('append: the same line in a row is one entry with a counter, a new time and unread again', () => {
		const read = markChatJournalRead(journalOf([info('a')]));
		const again = appendChatJournalEntry(read, info('a'), 5000, 200);
		assert.deepStrictEqual(again, [{ category: 'other', level: 'info', text: 'a', id: 1, at: 5000, count: 2, read: false }]);
	});

	test('append: the same line with another level, category, text or action is a different line', () => {
		const action = { kind: 'openSetting', settingId: 'vibeide.chat.journal.maxEntries' } as const;
		const entries = journalOf([
			info('a'),
			warning('a'),
			{ ...warning('a'), category: 'checks' },
			{ ...warning('a'), category: 'checks', actions: [action] },
			{ ...warning('a'), category: 'checks', actions: [action] },
		]);
		assert.deepStrictEqual(entries.map(entry => [entry.id, entry.count]), [[1, 1], [2, 1], [3, 1], [4, 2]]);
	});

	test('append: only the newest entry folds, the same line after another one is a new entry', () => {
		const entries = journalOf([info('a'), info('b'), info('a')]);
		assert.deepStrictEqual(entries.map(entry => [entry.text, entry.count]), [['a', 1], ['b', 1], ['a', 1]]);
	});

	test('append: over the limit the oldest entries leave and the ids go on', () => {
		const entries = journalOf([info('a'), info('b'), info('c'), info('d')], 3);
		assert.deepStrictEqual(entries.map(entry => [entry.id, entry.text]), [[2, 'b'], [3, 'c'], [4, 'd']]);
	});

	test('append: the text is trimmed and cut to the limit, and an empty line is not an entry', () => {
		const long = journalOf([info(`  ${'x'.repeat(CHAT_JOURNAL_MAX_TEXT_CHARS + 50)}  `)])[0]!;
		assert.deepStrictEqual({
			trimmed: journalOf([info('  a\n')]).map(entry => entry.text),
			empty: journalOf([info(''), info('  \n ')]),
			clipped: [long.text.length, long.text.endsWith('…')],
		}, { trimmed: ['a'], empty: [], clipped: [CHAT_JOURNAL_MAX_TEXT_CHARS, true] });
	});

	test('trim: cuts to a smaller limit and returns the same array when nothing has to go', () => {
		const entries = journalOf([info('a'), info('b'), info('c')]);
		assert.deepStrictEqual({
			cut: trimChatJournal(entries, 2).map(entry => entry.text),
			same: trimChatJournal(entries, 3) === entries,
		}, { cut: ['b', 'c'], same: true });
	});

	test('summary: counts entries not occurrences, and a warning is told apart only while unread', () => {
		const entries = journalOf([info('a'), info('a'), warning('w', 'checks')]);
		const read = markChatJournalRead(entries);
		const infoAgain = appendChatJournalEntry(read, info('i'), 9000, 200);
		assert.deepStrictEqual({
			fresh: summarizeChatJournal(entries),
			read: summarizeChatJournal(read),
			infoAgain: summarizeChatJournal(infoAgain),
			empty: summarizeChatJournal([]),
		}, {
			fresh: { total: 2, unread: 2, hasUnreadWarning: true },
			read: { total: 2, unread: 0, hasUnreadWarning: false },
			infoAgain: { total: 3, unread: 1, hasUnreadWarning: false },
			empty: { total: 0, unread: 0, hasUnreadWarning: false },
		});
	});

	test('markRead: everything read, and the same array when it already was', () => {
		const entries = markChatJournalRead(journalOf([info('a'), warning('b')]));
		assert.deepStrictEqual({
			flags: entries.map(entry => entry.read),
			same: markChatJournalRead(entries) === entries,
		}, { flags: [true, true], same: true });
	});

	test('filter: newest first, by category and by warnings only', () => {
		const entries = journalOf([info('a', 'providers'), warning('b', 'checks'), warning('c', 'providers'), info('d', 'checks')]);
		const texts = (categories: readonly string[], onlyWarnings: boolean) =>
			filterChatJournal(entries, { categories: new Set(categories as never), onlyWarnings }).map(entry => entry.text);
		assert.deepStrictEqual({
			all: texts([], false),
			providers: texts(['providers'], false),
			warnings: texts([], true),
			providersWarnings: texts(['providers'], true),
			two: texts(['providers', 'checks'], true),
		}, {
			all: ['d', 'c', 'b', 'a'],
			providers: ['c', 'a'],
			warnings: ['c', 'b'],
			providersWarnings: ['c'],
			two: ['c', 'b'],
		});
	});

	test('countByCategory: only the categories that have entries, in the fixed order', () => {
		const entries = journalOf([info('a', 'checks'), info('b', 'providers'), info('c', 'checks')]);
		assert.deepStrictEqual(countChatJournalByCategory(entries), [
			{ category: 'providers', count: 1 },
			{ category: 'checks', count: 2 },
		]);
	});

	test('limit: a whole number inside the bounds, anything else is the default', () => {
		assert.deepStrictEqual([200, 50.9, 1, 99999, '300', NaN, undefined, null].map(chatJournalLimitOf), [200, 50, 10, 2000, 200, 200, 200, 200]);
	});

	test('storage: an entry comes back as it went, with its actions', () => {
		const entries = journalOf([
			{ category: 'checks', level: 'warning', text: 'w', actions: [
				{ kind: 'openSetting', settingId: 'vibeide.agent.turnChecks.mode' },
				{ kind: 'openFile', resource: 'file:///a/.vibe/hooks.json' },
				{ kind: 'command', commandId: 'workbench.action.openSettings', label: 'Настройки', args: ['x'] },
			] },
			info('i'),
		]);
		assert.deepStrictEqual(parseChatJournal(serializeChatJournal(entries), 200), entries);
	});

	test('storage: damaged text, damaged entries and unknown actions cost only themselves', () => {
		const good = journalOf([info('good')])[0]!;
		const raw = JSON.stringify([
			good,
			{ ...good, id: 'x' },
			{ ...good, category: 'nowhere' },
			{ ...good, count: 0 },
			'text',
			{ ...good, id: 7, actions: [{ kind: 'openSetting', settingId: 's' }, { kind: 'launchRocket' }, { kind: 'openFile' }] },
		]);
		assert.deepStrictEqual({
			entries: parseChatJournal(raw, 200).map(entry => [entry.id, entry.actions]),
			notJson: parseChatJournal('{', 200),
			notArray: parseChatJournal('{"a":1}', 200),
			missing: parseChatJournal(undefined, 200),
			trimmed: parseChatJournal(serializeChatJournal(journalOf([info('a'), info('b'), info('c')])), 2).map(entry => entry.text),
		}, {
			entries: [[1, undefined], [7, [{ kind: 'openSetting', settingId: 's' }]]],
			notJson: [],
			notArray: [],
			missing: [],
			trimmed: ['b', 'c'],
		});
	});

	test('preview: a short text stays whole, a long one is cut by lines or by characters and says so', () => {
		const manyLines = ['1', '2', '3', '4', '5'].join('\n');
		const wide = 'w'.repeat(CHAT_JOURNAL_PREVIEW_CHARS + 20);
		assert.deepStrictEqual({
			short: previewChatJournalText('a\nb'),
			fourLines: previewChatJournalText('1\n2\n3\n4'),
			manyLines: previewChatJournalText(manyLines),
			wide: [previewChatJournalText(wide).text.length, previewChatJournalText(wide).truncated],
		}, {
			short: { text: 'a\nb', truncated: false },
			fourLines: { text: '1\n2\n3\n4', truncated: false },
			manyLines: { text: '1\n2\n3\n4…', truncated: true },
			wide: [CHAT_JOURNAL_PREVIEW_CHARS, true],
		});
	});

	test('spans: bold and code are marked, anything else is plain text as written', () => {
		assert.deepStrictEqual({
			mixed: chatJournalSpansOf('**Ответила другая модель**\nПросили: `gpt-5` / snake_case - dash'),
			plain: chatJournalSpansOf('без разметки * и ` одиночных'),
			unclosed: chatJournalSpansOf('**не закрыто'),
			empty: chatJournalSpansOf(''),
		}, {
			mixed: [
				{ text: 'Ответила другая модель', style: 'bold' },
				{ text: '\nПросили: ', style: 'plain' },
				{ text: 'gpt-5', style: 'code' },
				{ text: ' / snake_case - dash', style: 'plain' },
			],
			plain: [{ text: 'без разметки * и ` одиночных', style: 'plain' }],
			unclosed: [{ text: '**не закрыто', style: 'plain' }],
			empty: [],
		});
	});
});
