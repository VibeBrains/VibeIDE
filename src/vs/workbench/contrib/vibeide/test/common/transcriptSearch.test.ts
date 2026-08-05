/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { searchTranscripts, TranscriptThread } from '../../common/transcriptSearch.js';

suite('transcriptSearch — the whole conversation, not just its first line', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const thread = (threadId: string, lastModified: number, messages: [role: 'user' | 'assistant' | 'other', text: string][]): TranscriptThread =>
		({ threadId, lastModified, messages: messages.map(([role, text]) => ({ role, text })) });

	test('a phrase said mid-conversation is found — the defect this replaced could not', () => {
		const threads = [
			thread('t1', 10, [
				['user', 'Почини сборку'],
				['assistant', 'Смотрю логи.'],
				['user', 'Похоже, виноват манглер имён в минификаторе'],
			]),
			thread('t2', 20, [['user', 'Обнови зависимости']]),
		];

		assert.deepStrictEqual(
			searchTranscripts(threads, 'манглер').map(hit => [hit.threadId, hit.role, hit.messageIndex]),
			[['t1', 'user', 2]],
		);
	});

	test('the opening message outranks the same words said later, and the user outranks the model', () => {
		const threads = [
			thread('opening', 1, [['user', 'проблема с манглером']]),
			thread('later-user', 1, [['user', 'привет'], ['user', 'проблема с манглером']]),
			thread('assistant-only', 1, [['user', 'привет'], ['assistant', 'проблема с манглером']]),
			thread('machinery', 1, [['user', 'привет'], ['other', 'проблема с манглером']]),
		];

		assert.deepStrictEqual(
			searchTranscripts(threads, 'манглером').map(hit => hit.threadId),
			['opening', 'later-user', 'assistant-only', 'machinery'],
		);
	});

	test('a thread mentioning every term beats one mentioning some, and ties go to the newer thread', () => {
		const threads = [
			thread('partial', 900, [['user', 'ошибка сборки'], ['user', 'ошибка сборки снова']]),
			thread('all-terms', 100, [['user', 'ошибка'], ['user', 'манглер сломал имена']]),
			thread('same-as-partial-but-newer', 901, [['user', 'ошибка сборки'], ['user', 'ошибка сборки снова']]),
		];

		assert.deepStrictEqual(
			searchTranscripts(threads, 'ошибка манглер').map(hit => hit.threadId),
			['all-terms', 'same-as-partial-but-newer', 'partial'],
		);
	});

	test('the excerpt shows the matching line, cut around the term when the message is long', () => {
		const long = `${'сборка идёт долго. '.repeat(30)}виноват манглер имён. ${'дальше неважно. '.repeat(30)}`;
		const [hit] = searchTranscripts([thread('t', 1, [['user', 'старт'], ['user', long]])], 'манглер');

		assert.deepStrictEqual(
			[hit.excerpt.includes('манглер'), hit.excerpt.startsWith('…'), hit.excerpt.endsWith('…'), hit.excerpt.length < long.length],
			[true, true, true, true],
		);
	});

	test('no query terms and no matches both return nothing — never a zero-score list', () => {
		const threads = [thread('t', 1, [['user', 'сборка']])];

		assert.deepStrictEqual(
			[searchTranscripts(threads, '  ').length, searchTranscripts(threads, 'я').length, searchTranscripts(threads, 'деплой').length],
			[0, 0, 0],
		);
	});
});
