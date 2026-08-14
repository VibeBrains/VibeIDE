/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	AcpStreamDecoder,
	initializeParams,
	isNotification,
	isRequest,
	isResponse,
	newSessionParams,
	parseMessage,
	promptParams,
	authMethodsOf,
	parseSessionUpdate,
	stopReasonOf,
	toolCallFacts,
	type JsonValue,
} from '../../common/acp/acpProtocol.js';
import { describeToolCall } from '../../electron-main/acp/vibeAcpMainService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('acpProtocol', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('кадрирование потока', () => {
		test('сообщение, разрезанное между кусками, собирается', () => {
			const decoder = new AcpStreamDecoder();
			const first = decoder.push('{"jsonrpc":"2.0","id":1,"meth');
			const second = decoder.push('od":"initialize"}\n');
			assert.deepStrictEqual(
				[first.messages.length, second.messages.length, (second.messages[0] as { method: string }).method],
				[0, 1, 'initialize']);
		});

		test('несколько сообщений в одном куске', () => {
			const decoder = new AcpStreamDecoder();
			const { messages } = decoder.push('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","method":"session/update"}\n');
			assert.strictEqual(messages.length, 2);
		});

		test('чужая строка в stdout не роняет разбор, а уезжает отдельно', () => {
			// Агент печатает предупреждения рантайма в тот же поток; обрыв связи из-за чужого
			// console.log был бы худшим способом об этом узнать.
			const decoder = new AcpStreamDecoder();
			const { messages, garbage } = decoder.push('(node:1) Warning: что-то\n{"jsonrpc":"2.0","id":2,"result":1}\n');
			assert.deepStrictEqual([messages.length, garbage.length, garbage[0].startsWith('(node:1)')], [1, 1, true]);
		});

		test('пустые строки пропускаются, незавершённый хвост ждёт', () => {
			const decoder = new AcpStreamDecoder();
			const { messages } = decoder.push('\n\n{"jsonrpc":"2.0","id":3,"result":true}\n{"jsonrpc":"2.0"');
			assert.deepStrictEqual([messages.length, decoder.pending > 0], [1, true]);
		});
	});

	suite('различение сообщений', () => {
		test('запрос, уведомление и ответ не путаются', () => {
			const request = parseMessage('{"jsonrpc":"2.0","id":1,"method":"session/prompt"}')!;
			const notification = parseMessage('{"jsonrpc":"2.0","method":"session/update"}')!;
			const response = parseMessage('{"jsonrpc":"2.0","id":1,"result":{}}')!;
			assert.deepStrictEqual(
				[isRequest(request), isNotification(request), isNotification(notification), isResponse(response), isRequest(response)],
				[true, false, true, true, false]);
		});

		test('не-JSON, чужой протокол и ответ без id отвергаются', () => {
			assert.deepStrictEqual(
				[
					parseMessage('не json'),
					parseMessage('{"jsonrpc":"1.0","id":1,"method":"x"}'),
					parseMessage('{"jsonrpc":"2.0","result":{}}'),
					parseMessage('[1,2,3]'),
				],
				[undefined, undefined, undefined, undefined]);
		});
	});

	suite('кадры запросов', () => {
		test('возможности объявляются только те, что мы обслуживаем', () => {
			const fs = (initializeParams() as Record<string, JsonValue>)['clientCapabilities'] as Record<string, JsonValue>;
			assert.deepStrictEqual(fs['fs'], { readTextFile: true, writeTextFile: true });
		});

		test('session/new несёт обязательный mcpServers даже пустым', () => {
			const params = newSessionParams('/Users/me/project') as Record<string, JsonValue>;
			assert.deepStrictEqual([params['cwd'], params['mcpServers']], ['/Users/me/project', []]);
		});

		test('prompt передаётся блоками содержимого', () => {
			const params = promptParams('s1', 'почини сборку') as Record<string, JsonValue>;
			assert.deepStrictEqual(params['prompt'], [{ type: 'text', text: 'почини сборку' }]);
		});
	});

	suite('причина остановки', () => {
		test('известные значения приводятся, неизвестное НЕ считается успехом', () => {
			assert.deepStrictEqual(
				['completed', 'end_turn', 'cancelled', 'refusal', 'reached_max_turns', 'max_tokens', 'нечто', ''].map(stopReasonOf),
				['completed', 'completed', 'cancelled', 'refusal', 'max_turns', 'max_tokens', 'unknown', 'unknown']);
		});
	});

	suite('разбор session/update', () => {
		test('кусок ответа и кусок размышления различаются признаком, а не текстом', () => {
			const chunk = parseSessionUpdate({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'привет' } } });
			const thought = parseSessionUpdate({ sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'думаю' } } });
			assert.deepStrictEqual([chunk, thought], [
				{ kind: 'text', text: 'привет', thought: false },
				{ kind: 'text', text: 'думаю', thought: true },
			]);
		});

		test('правка приезжает вызовом инструмента с диффом — кадр живого Claude Code', () => {
			// Форма снята с прогона: клиентскую ФС этот агент не вызывает, и «было → стало»
			// достаётся только отсюда.
			const update = parseSessionUpdate({
				sessionId: 's',
				update: {
					sessionUpdate: 'tool_call_update',
					toolCallId: 'toolu_01',
					title: 'Edit /app/hello.txt',
					kind: 'edit',
					status: 'completed',
					rawInput: { file_path: '/app/hello.txt', old_string: 'привет мир', new_string: 'привет друг' },
					content: [{ type: 'diff', path: '/app/hello.txt', oldText: 'привет мир', newText: 'привет друг' }],
					locations: [{ path: '/app/hello.txt', line: 1 }],
				},
			});
			assert.deepStrictEqual(update, {
				kind: 'tool',
				toolCallId: 'toolu_01',
				title: 'Edit /app/hello.txt',
				toolKind: 'edit',
				status: 'completed',
				paths: ['/app/hello.txt'],
				diffs: [{ path: '/app/hello.txt', oldText: 'привет мир', newText: 'привет друг' }],
			});
		});

		test('незнакомая стадия не выдаётся за завершённую', () => {
			const update = parseSessionUpdate({ update: { sessionUpdate: 'tool_call', toolCallId: 't', status: 'нечто' } });
			assert.deepStrictEqual(update, { kind: 'tool', toolCallId: 't', title: '', toolKind: '', status: 'unknown', paths: [], diffs: [] });
		});

		test('расход хода: контекст и деньги', () => {
			assert.deepStrictEqual(
				[
					parseSessionUpdate({ update: { sessionUpdate: 'usage_update', used: 30244, size: 1000000, cost: { amount: 0.18, currency: 'USD' } } }),
					parseSessionUpdate({ update: { sessionUpdate: 'usage_update', used: 100, size: 200 } }),
				],
				[
					{ kind: 'usage', used: 30244, size: 1000000, costUsd: 0.18 },
					{ kind: 'usage', used: 100, size: 200 },
				]);
		});

		test('незнакомый вид обновления и битая форма молчат, а не бросают', () => {
			assert.deepStrictEqual(
				[
					parseSessionUpdate({ update: { sessionUpdate: 'current_mode_update', mode: 'ask' } }),
					parseSessionUpdate({ sessionId: 's' }),
					parseSessionUpdate(undefined),
				],
				[undefined, undefined, undefined]);
		});
	});

	suite('факты о вызове инструмента', () => {
		test('пути собираются из всех трёх мест, без повторов', () => {
			const facts = toolCallFacts({
				title: 'Edit',
				kind: 'edit',
				rawInput: { file_path: '/app/a.ts' },
				locations: [{ path: '/app/a.ts' }, { path: '/app/b.ts' }],
				content: [{ type: 'diff', path: '/app/c.ts', oldText: '', newText: 'новый' }],
			});
			assert.deepStrictEqual(facts.paths, ['/app/a.ts', '/app/b.ts', '/app/c.ts']);
		});

		test('создание файла — законный дифф с пустой левой стороной', () => {
			const facts = toolCallFacts({ content: [{ type: 'diff', path: '/app/new.ts', newText: 'содержимое' }] });
			assert.deepStrictEqual(facts.diffs, [{ path: '/app/new.ts', oldText: '', newText: 'содержимое' }]);
		});

		test('вызов без файлов не выдумывает путей', () => {
			assert.deepStrictEqual(toolCallFacts({ kind: 'execute', title: 'Bash' }), { title: 'Bash', toolKind: 'execute', paths: [], diffs: [] });
		});
	});

	suite('способы входа', () => {
		test('берутся из ответа на initialize — кадр живого Claude Code', () => {
			const methods = authMethodsOf({
				protocolVersion: 1,
				authMethods: [{ id: 'claude-login', name: 'Log in with Claude Code', description: 'Run `claude /login` in the terminal' }],
			});
			assert.deepStrictEqual(methods, [{ id: 'claude-login', name: 'Log in with Claude Code', description: 'Run `claude /login` in the terminal' }]);
		});

		test('способ без идентификатора отбрасывается: ответить им нечем', () => {
			assert.deepStrictEqual(authMethodsOf({ authMethods: [{ name: 'Без id' }, 'строка'] }), []);
		});

		test('агент без авторизации не ломает знакомство', () => {
			assert.deepStrictEqual([authMethodsOf({ protocolVersion: 1 }), authMethodsOf(undefined)], [[], []]);
		});
	});

	suite('описание действия для человека', () => {
		test('вид, название и затронутые файлы', () => {
			const text = describeToolCall({ kind: 'edit', title: 'Правка конфигурации', locations: [{ path: '/app/.env' }] });
			assert.deepStrictEqual([text.includes('edit'), text.includes('Правка конфигурации'), text.includes('/app/.env')], [true, true, true]);
		});

		test('незнакомая форма сворачивается в дамп, а не теряется', () => {
			const text = describeToolCall({ somethingNew: 'значение' });
			assert.ok(text.includes('somethingNew'), text);
		});

		test('пустое описание не роняет показ', () => {
			assert.strictEqual(typeof describeToolCall(undefined), 'string');
		});
	});
});
