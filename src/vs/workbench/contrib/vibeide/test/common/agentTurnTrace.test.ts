/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AGENT_TURN_DETAIL_MAX_CHARS,
	AGENT_TURN_TRACE_CAPACITY,
	clearAgentTurnTrace,
	formatAgentTurnTrace,
	getAgentTurnTrace,
	traceAgentStep,
} from '../../common/agentTurnTrace.js';

suite('agentTurnTrace — пошаговый трейс хода', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => clearAgentTurnTrace());
	teardown(() => clearAgentTurnTrace());

	test('нумерация идёт по треду, а не сквозная — параллельные ходы не чередуются', () => {
		traceAgentStep({ threadId: 'a', kind: 'turn-start' }, 1000);
		traceAgentStep({ threadId: 'b', kind: 'turn-start' }, 1001);
		traceAgentStep({ threadId: 'a', kind: 'llm-request' }, 1002);
		assert.deepStrictEqual(
			[getAgentTurnTrace('a').map(s => s.seq), getAgentTurnTrace('b').map(s => s.seq)],
			[[1, 2], [1]],
		);
	});

	test('снимок по треду отдаёт только его шаги', () => {
		traceAgentStep({ threadId: 'a', kind: 'tool-call', name: 'read_file' }, 1000);
		traceAgentStep({ threadId: 'b', kind: 'tool-call', name: 'run_command' }, 1001);
		assert.deepStrictEqual(getAgentTurnTrace('b').map(s => s.name), ['run_command']);
	});

	test('пометка усекается — в трейс не должно попадать содержимое', () => {
		traceAgentStep({ threadId: 'a', kind: 'tool-error', detail: 'x'.repeat(500) }, 1000);
		assert.strictEqual(getAgentTurnTrace('a')[0].detail?.length, AGENT_TURN_DETAIL_MAX_CHARS);
	});

	test('кольцо вытесняет старое и не растёт', () => {
		for (let i = 0; i < AGENT_TURN_TRACE_CAPACITY + 50; i++) {
			traceAgentStep({ threadId: 'a', kind: 'llm-request' }, 1000 + i);
		}
		const all = getAgentTurnTrace();
		assert.deepStrictEqual([all.length, all[0].seq], [AGENT_TURN_TRACE_CAPACITY, 51]);
	});

	test('разбор отвечает на вопросы, ради которых трейс открывают', () => {
		traceAgentStep({ threadId: 'a', kind: 'turn-start' }, 0);
		traceAgentStep({ threadId: 'a', kind: 'llm-request', name: 'claude' }, 1000);
		traceAgentStep({ threadId: 'a', kind: 'llm-retry', name: 'claude' }, 2000);
		traceAgentStep({ threadId: 'a', kind: 'tool-call', name: 'run_command' }, 3000);
		traceAgentStep({ threadId: 'a', kind: 'tool-error', name: 'run_command', ok: false, detail: 'exit 1' }, 4000);
		traceAgentStep({ threadId: 'a', kind: 'nudge' }, 5000);
		const text = formatAgentTurnTrace('a', getAgentTurnTrace());
		assert.deepStrictEqual(
			[/Шагов: 6/.test(text), /Запросов к модели: 1 \(повторов: 1\)/.test(text), /с ошибкой: 1 \(run_command\)/.test(text), /авто-продолжений: 1/.test(text)],
			[true, true, true, true],
		);
	});

	test('пустой трейс говорит, что он пуст, а не рисует пустую таблицу', () => {
		assert.match(formatAgentTurnTrace('нет-такого', getAgentTurnTrace()), /Трейс пуст/);
	});
});
