/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mirrorAcpEntries } from '../../common/acp/acpThreadMirror.js';
import { AcpSessionLog } from '../../common/acp/acpSessionLog.js';

suite('acpThreadMirror', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const tool = (log: AcpSessionLog, id: string, status: 'in_progress' | 'completed', extra: { output?: string; exitCode?: number } = {}) =>
		log.applyTool({ toolCallId: id, title: 'git status', name: 'Bash', toolKind: 'execute', status, paths: [], diffs: [], output: extra.output ?? '', ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }) });

	test('мысль и следующий за ней ответ — одно сообщение: рассуждение над ответом', () => {
		const log = new AcpSessionLog();
		log.appendText('думаю', true);
		log.appendText('Готово', false);
		const blocks = mirrorAcpEntries(log.snapshot.entries, 0);
		assert.deepStrictEqual(blocks.map(block => [block.key, block.message]), [
			['m1', { role: 'assistant', displayContent: 'Готово', reasoning: 'думаю', anthropicReasoning: null }],
		]);
	});

	test('вызов инструмента разрывает пару и стоит между репликами в порядке событий', () => {
		const log = new AcpSessionLog();
		log.appendText('Смотрю', false);
		tool(log, 't1', 'completed', { output: 'чисто', exitCode: 0 });
		log.appendText('Всё чисто', false);
		const blocks = mirrorAcpEntries(log.snapshot.entries, 0);
		assert.deepStrictEqual(blocks.map(block => [block.key, block.message.role]), [['m1', 'assistant'], ['tool:t1', 'acp_tool'], ['m2', 'assistant']]);
		assert.deepStrictEqual(blocks[1].message, {
			role: 'acp_tool', toolCallId: 't1', title: 'git status', name: 'Bash', toolKind: 'execute', status: 'completed', paths: [], diffs: [], output: 'чисто', exitCode: 0,
		});
	});

	test('ключ блока не меняется, пока блок растёт; изменение видно по ссылке на источник', () => {
		const log = new AcpSessionLog();
		log.appendText('Смо', false);
		const first = mirrorAcpEntries(log.snapshot.entries, 0)[0];
		log.appendText('трю', false);
		const second = mirrorAcpEntries(log.snapshot.entries, 0)[0];
		assert.deepStrictEqual(
			[first.key === second.key, first.sources[0] === second.sources[0], (second.message as { displayContent: string }).displayContent],
			[true, false, 'Смотрю']);
	});

	test('ход читается с начала хода, а не с начала сессии', () => {
		const log = new AcpSessionLog();
		log.appendText('Прошлый ход', false);
		const start = log.beginTurn();
		log.appendText('Новый ход', false);
		assert.deepStrictEqual(
			mirrorAcpEntries(log.snapshot.entries, start).map(block => (block.message as { displayContent: string }).displayContent),
			['Новый ход']);
	});

	test('начало хода не склеивает его первый текст с последним ответом прошлого хода', () => {
		const log = new AcpSessionLog();
		log.appendText('Прошлый', false);
		log.beginTurn();
		log.appendText('Новый', false);
		log.appendText(' дальше', false);
		assert.deepStrictEqual(log.snapshot.entries.map(entry => entry.kind === 'message' ? entry.text : ''), ['Прошлый', 'Новый дальше']);
	});

	test('пометка редактора — служебное сообщение, а не ответ агента', () => {
		const log = new AcpSessionLog();
		log.appendNotice('Связь восстановлена');
		assert.deepStrictEqual(mirrorAcpEntries(log.snapshot.entries, 0)[0].message, {
			role: 'assistant', displayContent: 'Связь восстановлена', reasoning: '', anthropicReasoning: null, notice: true,
		});
	});

	test('мысль без ответа остаётся сообщением с одним рассуждением', () => {
		const log = new AcpSessionLog();
		log.appendText('размышляю', true);
		tool(log, 't1', 'in_progress');
		assert.deepStrictEqual(mirrorAcpEntries(log.snapshot.entries, 0).map(block => [block.key, block.message.role]), [['m1', 'assistant'], ['tool:t1', 'acp_tool']]);
	});
});
