/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AcpSessionLog } from '../../common/acp/acpSessionLog.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('acpSessionLog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const diff = { path: '/app/hello.txt', oldText: 'привет мир', newText: 'привет друг' };

	test('куски текста склеиваются в одну реплику', () => {
		const log = new AcpSessionLog();
		log.appendText('Гот', false);
		log.appendText('ово.', false);
		assert.deepStrictEqual(log.snapshot.entries, [{ kind: 'message', id: 'm1', text: 'Готово.', thought: false }]);
	});

	test('размышление и ответ не слипаются', () => {
		const log = new AcpSessionLog();
		log.appendText('думаю', true);
		log.appendText('отвечаю', false);
		assert.deepStrictEqual(
			log.snapshot.entries.map(entry => entry.kind === 'message' ? [entry.text, entry.thought] : entry.kind),
			[['думаю', true], ['отвечаю', false]]);
	});

	test('вызов инструмента разрывает склейку текста', () => {
		// Иначе сказанное до действия и сказанное после читались бы как одна мысль.
		const log = new AcpSessionLog();
		log.appendText('сейчас прочитаю', false);
		log.applyTool({ toolCallId: 't1', title: 'Read', name: '', toolKind: 'read', status: 'completed', paths: ['/app/a.ts'], diffs: [] });
		log.appendText('прочитал', false);
		assert.deepStrictEqual(log.snapshot.entries.map(entry => entry.id), ['m1', 't1', 'm2']);
	});

	/** Имя инструмента стабилизировано в ACP v1; в обновлении пустое значит «не менять». */
	test('имя инструмента запоминается и не затирается пустым кадром, отмена не читается как «неизвестно»', () => {
		const log = new AcpSessionLog();
		log.applyTool({ toolCallId: 't9', title: 'Читаю файл', name: 'read_file', toolKind: 'read', status: 'in_progress', paths: [], diffs: [] });
		log.applyTool({ toolCallId: 't9', title: '', name: '', toolKind: '', status: 'cancelled', paths: [], diffs: [] });
		const entry = log.snapshot.entries[0];
		assert.deepStrictEqual(
			entry.kind === 'tool' ? [entry.name, entry.title, entry.status] : [],
			['read_file', 'Читаю файл', 'cancelled'],
		);
	});

	test('кадры одного вызова сворачиваются в одну карточку, дифф доживает до конца', () => {
		// Порядок живого прогона: дифф в среднем кадре, завершающий приходит пустым.
		const log = new AcpSessionLog();
		log.applyTool({ toolCallId: 't1', title: 'Edit', name: '', toolKind: 'edit', status: 'pending', paths: [], diffs: [] });
		log.applyTool({ toolCallId: 't1', title: 'Edit /app/hello.txt', name: '', toolKind: 'edit', status: 'unknown', paths: ['/app/hello.txt'], diffs: [diff] });
		log.applyTool({ toolCallId: 't1', title: '', name: '', toolKind: '', status: 'completed', paths: [], diffs: [] });
		assert.deepStrictEqual(log.snapshot.entries, [{
			kind: 'tool',
			id: 't1',
			title: 'Edit /app/hello.txt',
			name: '',
			toolKind: 'edit',
			status: 'completed',
			paths: ['/app/hello.txt'],
			diffs: [diff],
		}]);
	});

	test('провал вызова виден: стадия меняется в любую сторону', () => {
		const log = new AcpSessionLog();
		log.applyTool({ toolCallId: 't1', title: 'Edit', name: '', toolKind: 'edit', status: 'in_progress', paths: [], diffs: [diff] });
		log.applyTool({ toolCallId: 't1', title: '', name: '', toolKind: '', status: 'failed', paths: [], diffs: [] });
		assert.strictEqual((log.snapshot.entries[0] as { status: string }).status, 'failed');
	});

	test('карточка обновляется на месте, а не уезжает в конец ленты', () => {
		const log = new AcpSessionLog();
		log.applyTool({ toolCallId: 't1', title: 'Read', name: '', toolKind: 'read', status: 'pending', paths: [], diffs: [] });
		log.appendText('пишу', false);
		log.applyTool({ toolCallId: 't1', title: 'Read', name: '', toolKind: 'read', status: 'completed', paths: [], diffs: [] });
		assert.deepStrictEqual(log.snapshot.entries.map(entry => entry.id), ['t1', 'm1']);
	});

	test('расход заменяется последним значением, а не суммируется', () => {
		// Значения накопительные за сессию: сложение посчитало бы одни токены дважды.
		const log = new AcpSessionLog();
		log.applySpend(100, 1000000, 0.1);
		log.applySpend(30244, 1000000, 0.188698);
		assert.deepStrictEqual(log.snapshot.spend, { used: 30244, size: 1000000, costUsd: 0.188698 });
	});

	test('расход без цены не выдумывает нуля', () => {
		const log = new AcpSessionLog();
		log.applySpend(100, 200, undefined);
		assert.deepStrictEqual(log.snapshot.spend, { used: 100, size: 200 });
	});
});
