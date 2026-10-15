/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IDE_MCP_MAX_PROBLEMS,
	IDE_MCP_MAX_TABS,
	IDE_MCP_PROTOCOL_VERSIONS,
	IDE_MCP_TOOLS,
	IDE_TOOL_OPEN_FILE,
	IDE_TOOL_PROBLEMS,
	IIdeMcpToolResult,
	IdeMcpToolCaller,
	formatOpenFile,
	formatProblems,
	handleIdeMcpBody,
} from '../../common/acp/acpIdeMcp.js';
import { JsonValue } from '../../common/acp/acpProtocol.js';

suite('acpIdeMcp', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const answer = (text: string): IdeMcpToolCaller => async () => ({ text });
	/** `id` null — a notification: no id on the wire */
	const rpc = (method: string, params?: JsonValue, id: number | null = 1) => JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params === undefined ? {} : { params }) });
	const resultOf = (reply: { body?: JsonValue }) => (reply.body as { result: Record<string, JsonValue> }).result;
	const errorOf = (reply: { body?: JsonValue }) => (reply.body as { error: { code: number } }).error.code;

	suite('протокол', () => {
		test('знакомство: известная ревизия возвращается как есть, неизвестной отвечаем своей', async () => {
			const known = await handleIdeMcpBody(rpc('initialize', { protocolVersion: '2025-03-26' }), answer(''));
			const unknown = await handleIdeMcpBody(rpc('initialize', { protocolVersion: '2031-01-01' }), answer(''));
			assert.deepStrictEqual(
				[resultOf(known)['protocolVersion'], resultOf(unknown)['protocolVersion'], resultOf(known)['capabilities'], resultOf(known)['serverInfo']],
				['2025-03-26', IDE_MCP_PROTOCOL_VERSIONS[1], { tools: {} }, { name: 'vibe-ide', version: '1' }]);
		});

		test('уведомление отвечается статусом, без тела; ping — пустым результатом', async () => {
			const notification = await handleIdeMcpBody(rpc('notifications/initialized', undefined, null), answer(''));
			const ping = await handleIdeMcpBody(rpc('ping'), answer(''));
			assert.deepStrictEqual([notification, resultOf(ping)], [{ status: 202 }, {}]);
		});

		test('список инструментов — в фиксированном порядке, с описанием и схемой', async () => {
			const reply = await handleIdeMcpBody(rpc('tools/list'), answer(''));
			const tools = resultOf(reply)['tools'] as { name: string; description: string; inputSchema: JsonValue }[];
			assert.deepStrictEqual(tools.map(tool => tool.name), [IDE_TOOL_OPEN_FILE, IDE_TOOL_PROBLEMS]);
			assert.ok(tools.every(tool => tool.description.length > 0 && (tool.inputSchema as { type: string }).type === 'object'));
			assert.strictEqual(IDE_MCP_TOOLS.length, tools.length);
		});

		test('вызов инструмента доходит до редактора с аргументами, ответ — текстовым блоком', async () => {
			const seen: [string, Record<string, JsonValue>][] = [];
			const reply = await handleIdeMcpBody(rpc('tools/call', { name: IDE_TOOL_PROBLEMS, arguments: { path: 'src/a.ts' } }), async (tool, args) => {
				seen.push([tool, args]);
				return { text: 'ответ' };
			});
			assert.deepStrictEqual([seen, resultOf(reply)], [[[IDE_TOOL_PROBLEMS, { path: 'src/a.ts' }]], { content: [{ type: 'text', text: 'ответ' }], isError: false }]);
		});

		test('отказ инструмента виден агенту как isError, а не как успех', async () => {
			const failing: IdeMcpToolCaller = async (): Promise<IIdeMcpToolResult> => ({ text: 'окно закрыто', isError: true });
			const reply = await handleIdeMcpBody(rpc('tools/call', { name: IDE_TOOL_OPEN_FILE }), failing);
			assert.strictEqual(resultOf(reply)['isError'], true);
		});

		test('ошибки протокола: не JSON, пакет, чужой метод, чужой инструмент, упавший редактор', async () => {
			const throwing: IdeMcpToolCaller = async () => { throw new Error('сломалось'); };
			const codes = [
				await handleIdeMcpBody('не json', answer('')),
				await handleIdeMcpBody('[]', answer('')),
				await handleIdeMcpBody(rpc('resources/list'), answer('')),
				await handleIdeMcpBody(rpc('tools/call', { name: 'rm_rf' }), answer('')),
				await handleIdeMcpBody(rpc('tools/call', { name: IDE_TOOL_OPEN_FILE }), throwing),
			].map(errorOf);
			assert.deepStrictEqual(codes, [-32700, -32600, -32601, -32602, -32603]);
		});
	});

	suite('ответ vibe_open_file', () => {
		const redact = (text: string) => text.replace('СЕКРЕТ', '[[REDACTED]]');

		test('путь, выделение, текст и остальные вкладки', () => {
			const text = formatOpenFile({
				activeFile: { path: '/app/a.ts', languageId: 'typescript', text: 'const x = 1;', selection: { startLine: 1, endLine: 1, text: 'x = 1' } },
				otherTabs: ['/app/b.ts'],
			}, 1000, redact);
			assert.strictEqual(text, [
				'Открытый файл: /app/a.ts (typescript)',
				'',
				'Выделено человеком: строки 1-1',
				'```\nx = 1\n```',
				'',
				'Текст файла:',
				'```\nconst x = 1;\n```',
				'',
				'Другие открытые вкладки:\n/app/b.ts',
			].join('\n'));
		});

		test('длинный текст обрезается, и обрезка названа', () => {
			const text = formatOpenFile({ activeFile: { path: '/app/a.ts', text: 'y'.repeat(50) }, otherTabs: [] }, 10, redact);
			assert.ok(text.includes('первые 10 из 50 знаков, остальное обрезано'));
			assert.ok(!text.includes('y'.repeat(11)));
		});

		test('ключ в тексте и в выделении маскируется', () => {
			const text = formatOpenFile({ activeFile: { path: '/app/a.ts', text: 'k = СЕКРЕТ', selection: { startLine: 1, endLine: 1, text: 'СЕКРЕТ' } }, otherTabs: [] }, 1000, redact);
			assert.deepStrictEqual([text.includes('СЕКРЕТ'), text.split('[[REDACTED]]').length - 1], [false, 2]);
		});

		test('пустой редактор и лишние вкладки', () => {
			const none = formatOpenFile({ otherTabs: [] }, 1000, redact);
			const many = formatOpenFile({ otherTabs: Array.from({ length: IDE_MCP_MAX_TABS + 2 }, (_, i) => `/app/f${i}.ts`) }, 1000, redact);
			assert.deepStrictEqual([none, many.includes(`/app/f${IDE_MCP_MAX_TABS}.ts`), many.includes('... и ещё 2')], [
				'В редакторе не открыт ни один файл.\n\nДругих открытых вкладок нет.', false, true]);
		});
	});

	suite('ответ vibe_problems', () => {
		test('строка на проблему: номер, важность, сообщение, источник и текст строки', () => {
			const text = formatProblems({ kind: 'found', path: '/app/a.ts', problems: [{ line: 3, severity: 'error', message: 'Нет имени x', source: 'ts', lineText: '   use(x);  ' }] });
			assert.strictEqual(text, 'Проблемы файла /app/a.ts:\n3: [ошибка] Нет имени x (ts)  |  use(x);');
		});

		test('пустой список — ответ «ничего не подчёркнуто», а закрытый файл — не пустой список', () => {
			assert.deepStrictEqual([
				formatProblems({ kind: 'found', path: '/app/a.ts', problems: [] }),
				formatProblems({ kind: 'notOpen', path: '/app/b.ts' }).includes('Это не значит, что ошибок нет'),
				formatProblems({ kind: 'closed', path: '/app/.env' }).includes('.vibe/ignore'),
				formatProblems({ kind: 'noFile' }),
			], [
				'В /app/a.ts редактор ничего не подчеркнул.',
				true,
				true,
				'Путь не указан, и в редакторе нет открытого файла.',
			]);
		});

		test('проблем больше предела — лишние считаются', () => {
			const problems = Array.from({ length: IDE_MCP_MAX_PROBLEMS + 5 }, (_, i) => ({ line: i + 1, severity: 'warning' as const, message: 'm', lineText: '' }));
			const text = formatProblems({ kind: 'found', path: '/app/a.ts', problems });
			assert.deepStrictEqual([text.split('\n').length, text.endsWith('... и ещё 5')], [IDE_MCP_MAX_PROBLEMS + 2, true]);
		});
	});
});
