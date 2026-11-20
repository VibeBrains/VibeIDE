/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	CODE_MODE_MAX_CALLS,
	CODE_MODE_MAX_OUTPUT_CHARS,
	CODE_MODE_TIMEOUT_SEC_DEFAULT,
	buildCodeModeReport,
	codeModeCallBudgetError,
	codeModeLimits,
	codeModeNeedsApproval,
	codeModeToolRefusal,
} from '../../common/codeMode/codeMode.js';
import { ChatPermissionMode, IToolApprovalContext, IToolCallFacts } from '../../common/chatPermissionMode.js';

/** Контекст решения для теста: один корень проекта и никаких постоянных разрешений */
function approvalContext(mode: ChatPermissionMode): IToolApprovalContext {
	return {
		mode,
		roots: ['/project'],
		caseInsensitivePaths: false,
		grants: { terminal: false, mcp: false },
		confirmDestructiveCommands: true,
	};
}

suite('Code Mode — чистые правила', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('пределы времени берутся из настройки и зажимаются', () => {
		assert.deepStrictEqual(
			[codeModeLimits(15), codeModeLimits(0), codeModeLimits(10_000), codeModeLimits('нет')],
			[
				{ timeoutSec: 15, maxCalls: CODE_MODE_MAX_CALLS },
				{ timeoutSec: 1, maxCalls: CODE_MODE_MAX_CALLS },
				{ timeoutSec: 300, maxCalls: CODE_MODE_MAX_CALLS },
				{ timeoutSec: CODE_MODE_TIMEOUT_SEC_DEFAULT, maxCalls: CODE_MODE_MAX_CALLS },
			],
		);
	});

	test('путь к прототипу и вложенный Code Mode отвергаются', () => {
		assert.deepStrictEqual(
			['__proto__', 'prototype', 'constructor', 'run_code_mode', 'run-code-mode', ''].map(codeModeToolRefusal),
			[
				'«__proto__» — это путь к прототипу, а не имя инструмента',
				'«prototype» — это путь к прототипу, а не имя инструмента',
				'«constructor» — это путь к прототипу, а не имя инструмента',
				'«run_code_mode» из скрипта недоступен: вложенный Code Mode запрещён',
				'«run-code-mode» — недопустимое имя инструмента: разрешены строчная латиница, цифры и подчёркивание',
				'«» — недопустимое имя инструмента: разрешены строчная латиница, цифры и подчёркивание',
			],
		);
	});

	test('обычное имя инструмента проходит проверку', () => {
		assert.deepStrictEqual(['read_file', 'run_command', 'grep'].map(codeModeToolRefusal), [undefined, undefined, undefined]);
	});

	test('бюджет вызовов кончается на пределе', () => {
		assert.deepStrictEqual(
			[codeModeCallBudgetError(0, 1), codeModeCallBudgetError(1, 1), codeModeCallBudgetError(CODE_MODE_MAX_CALLS)],
			[undefined, `Исчерпан предел вложенных вызовов (1)`, `Исчерпан предел вложенных вызовов (${CODE_MODE_MAX_CALLS})`],
		);
	});

	test('вложенный вызов решается тем же правилом, что и обычный', () => {
		const editFacts: IToolCallFacts = { kind: 'edit', paths: ['/project/a.ts'] };
		const readFacts: IToolCallFacts = { kind: 'read', paths: ['/project/a.ts'] };
		const outsideReadFacts: IToolCallFacts = { kind: 'read', paths: ['/other/a.ts'] };
		assert.deepStrictEqual(
			[
				codeModeNeedsApproval(editFacts, approvalContext('manual')),
				codeModeNeedsApproval(editFacts, approvalContext('auto')),
				codeModeNeedsApproval(readFacts, approvalContext('manual')),
				codeModeNeedsApproval(outsideReadFacts, approvalContext('auto')),
			],
			[true, false, false, true],
		);
	});

	test('отчёт собирает вывод, значение и список вложенных вызовов', () => {
		assert.deepStrictEqual(
			buildCodeModeReport({
				logs: ['строка один', 'строка два'],
				valueText: '{"done":true}',
				calls: [{ tool: 'read_file', ok: true }, { tool: 'edit_file', ok: false, error: 'нет файла' }],
			}),
			'Вывод console.log (2):\nстрока один\nстрока два\n\nЗначение скрипта (JSON):\n{"done":true}\n\nВложенные вызовы (2):\n- read_file: успех\n- edit_file: ошибка — нет файла',
		);
	});

	test('длинный отчёт обрезается с честной пометкой', () => {
		const report = buildCodeModeReport({ logs: ['я'.repeat(CODE_MODE_MAX_OUTPUT_CHARS * 2)], calls: [] });
		assert.deepStrictEqual(report.length > CODE_MODE_MAX_OUTPUT_CHARS && report.includes('обрезано'), true);
	});
});
