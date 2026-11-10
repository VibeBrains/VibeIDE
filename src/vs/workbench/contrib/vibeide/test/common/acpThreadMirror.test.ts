/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mirrorAcpEntries, nextMirrorCursor } from '../../common/acp/acpThreadMirror.js';
import { AcpSessionLog } from '../../common/acp/acpSessionLog.js';

suite('acpThreadMirror', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const tool = (log: AcpSessionLog, id: string, status: 'pending' | 'in_progress' | 'completed', extra: { output?: string; exitCode?: number } = {}) =>
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

	test('notice агента — отдельное сообщение с тяжестью, не путается с пометкой редактора', () => {
		const log = new AcpSessionLog();
		log.appendAcpNotice({ severity: 'error', title: 'Сломалось', description: 'подробности' });
		log.appendNotice('Связь восстановлена');
		assert.deepStrictEqual(mirrorAcpEntries(log.snapshot.entries, 0).map(block => [block.key, block.message]), [
			['notice:an1', { role: 'acp_notice', severity: 'error', title: 'Сломалось', description: 'подробности' }],
			['n2', { role: 'assistant', displayContent: 'Связь восстановлена', reasoning: '', anthropicReasoning: null, notice: true }],
		]);
	});

	test('compaction — сообщение со статусом и сводкой, растёт на месте по compactionId', () => {
		const log = new AcpSessionLog();
		log.applyCompaction({ compactionId: 'cmp-1', status: 'in_progress' });
		const opened = mirrorAcpEntries(log.snapshot.entries, 0);
		log.applyCompactionChunk('cmp-1', 'Итог разговора');
		log.applyCompaction({ compactionId: 'cmp-1', status: 'completed' });
		const done = mirrorAcpEntries(log.snapshot.entries, 0);
		assert.deepStrictEqual([opened.length, done.length], [1, 1]);
		assert.deepStrictEqual(opened[0].message, { role: 'acp_compaction', compactionId: 'cmp-1', status: 'in_progress', summary: '' });
		assert.deepStrictEqual(done[0].message, { role: 'acp_compaction', compactionId: 'cmp-1', status: 'completed', summary: 'Итог разговора' });
		// Ключ стабилен — раннер перепишет сообщение на месте, а не добавит второе
		assert.strictEqual(opened[0].key, done[0].key);
	});

	test('compaction с ошибкой несёт её в сообщение', () => {
		const log = new AcpSessionLog();
		log.applyCompaction({ compactionId: 'cmp-2', status: 'failed', error: 'модель недоступна' });
		assert.deepStrictEqual(mirrorAcpEntries(log.snapshot.entries, 0)[0].message, {
			role: 'acp_compaction', compactionId: 'cmp-2', status: 'failed', summary: '', error: 'модель недоступна',
		});
	});
	test('курсор не уходит дальше первого незавершённого вызова: статусы параллельных команд доходят до чата', () => {
		const log = new AcpSessionLog();
		log.appendText('Запускаю', false);
		for (const id of ['a', 'b', 'c', 'd']) {
			tool(log, id, 'pending');
		}
		const cursors: number[] = [];
		let cursor = nextMirrorCursor(log.snapshot.entries, 0);
		cursors.push(cursor);
		tool(log, 'a', 'completed');
		tool(log, 'b', 'completed');
		cursor = nextMirrorCursor(log.snapshot.entries, cursor);
		cursors.push(cursor);
		const statuses = mirrorAcpEntries(log.snapshot.entries, cursors[0]).map(block => block.message.role === 'acp_tool' ? block.message.status : block.message.role);
		tool(log, 'c', 'completed');
		tool(log, 'd', 'completed');
		log.appendText('Готово', false);
		cursors.push(nextMirrorCursor(log.snapshot.entries, cursor));
		assert.deepStrictEqual({ cursors, statuses }, { cursors: [1, 3, 5], statuses: ['completed', 'completed', 'pending', 'pending'] });
	});
});
