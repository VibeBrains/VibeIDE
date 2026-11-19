/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
// Песочница живёт в node/ и проверяется там же, где исполняется: vm требует настоящего Node
import { runCodeModeScript } from '../../node/codeMode/codeModeVm.js';
import { skipInElectronRenderer } from './nodeOnly.js';

const TIMEOUT_MS = 2_000;

function run(script: string, callTool?: (tool: string, argsJson: string) => Promise<{ ok: boolean; text: string }>) {
	return runCodeModeScript({
		script,
		timeoutMs: TIMEOUT_MS,
		maxCalls: 5,
		callTool: callTool ?? (async () => ({ ok: true, text: 'ok' })),
	});
}

suite('Code Mode — песочница vm', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suiteSetup(function () {
		skipInElectronRenderer(this);
	});

	test('скрипт возвращает значение и собирает console.log', async () => {
		const outcome = await run('console.log("привет", 2); return { sum: Math.max(1, 2) };');
		assert.deepStrictEqual([outcome.logs, outcome.valueText, outcome.error], [['привет 2'], '{"sum":2}', undefined]);
	});

	test('require, process, module и globalThis.process недоступны', async () => {
		const outcome = await run('return [typeof require, typeof process, typeof module, typeof globalThis.process, typeof require === "undefined" ? "нет" : "есть"];');
		assert.deepStrictEqual(outcome.valueText, '["undefined","undefined","undefined","undefined","нет"]');
	});

	test('побег через constructor.constructor не даёт process', async () => {
		const outcome = await run('try { return typeof [].constructor.constructor("return process")(); } catch (e) { return "заблокировано"; }');
		assert.deepStrictEqual(outcome.valueText, '"заблокировано"');
	});

	test('Function и eval не создают код', async () => {
		const outcome = await run('try { return typeof Function("return process")(); } catch (e) { try { return typeof eval("process"); } catch (e2) { return "заблокировано"; } }');
		assert.deepStrictEqual(outcome.valueText, '"заблокировано"');
	});

	test('import() не загружает модули', async () => {
		const outcome = await run('try { await import("fs"); return "загружено"; } catch (e) { return "заблокировано"; }');
		assert.deepStrictEqual(outcome.valueText, '"заблокировано"');
	});

	test('вложенный run_code_mode запрещён', async () => {
		const outcome = await run('try { await tools.run_code_mode({ script: "return 1" }); return "выполнено"; } catch (e) { return "заблокировано"; }');
		assert.deepStrictEqual([outcome.valueText, outcome.calls.length], ['"заблокировано"', 1]);
	});

	test('имя __proto__ не становится инструментом', async () => {
		const outcome = await run('try { await tools.__proto__({}); return "выполнено"; } catch (e) { return "заблокировано"; }');
		assert.deepStrictEqual([outcome.valueText, outcome.calls[0]?.ok], ['"заблокировано"', false]);
	});

	test('бесконечный цикл снимается по времени', async () => {
		const outcome = await run('while (true) { }');
		assert.deepStrictEqual(outcome.error?.startsWith('Превышено время'), true);
	});

	test('вложенный вызов возвращает ответ инструмента', async () => {
		const outcome = await run('return await tools.read_file({ uri: "a.ts" });', async () => ({ ok: true, text: 'содержимое' }));
		assert.deepStrictEqual([outcome.valueText, outcome.calls], ['"содержимое"', [{ tool: 'read_file', ok: true }]]);
	});
});
