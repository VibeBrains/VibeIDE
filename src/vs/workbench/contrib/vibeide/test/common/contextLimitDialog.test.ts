/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BUDGET_FILL_MIN_MESSAGES, ContextLimitDialogGate, DEFAULT_PRESERVE_NOTE, ForceCompactFlag, shouldBudgetFill } from '../../common/contextLimitDialog.js';

suite('contextLimitDialog — диалог сжатия при заполнении контекста', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('показ: один раз на тред, другой тред и reset() снова открывают диалог', () => {
		const gate = new ContextLimitDialogGate();
		const base = { enabled: true, threadId: 'a', percentUsed: 92, criticalThresholdPercent: 90 };
		const first = gate.shouldShow(base);
		gate.markShown('a');
		const second = gate.shouldShow(base);
		const otherThread = gate.shouldShow({ ...base, threadId: 'b' });
		gate.reset();
		const afterReset = gate.shouldShow(base);
		assert.deepStrictEqual([first, second, otherThread, afterReset], [true, false, true, true]);
	});

	test('показ: настройка выключена или порог не достигнут — диалога нет', () => {
		const gate = new ContextLimitDialogGate();
		const base = { enabled: true, threadId: 'a', percentUsed: 92, criticalThresholdPercent: 90 };
		assert.deepStrictEqual(
			[
				gate.shouldShow({ ...base, enabled: false }),
				gate.shouldShow({ ...base, percentUsed: 89.9 }),
				gate.shouldShow({ ...base, percentUsed: 90 }),
			],
			[false, false, true],
		);
	});

	test('флаг сжатия: забирается один раз и снимается, reset() гасит запрос', () => {
		const flag = new ForceCompactFlag();
		const initiallyRequested = flag.requested;
		flag.request();
		const requested = flag.requested;
		const firstConsume = flag.consume();
		const secondConsume = flag.consume();
		flag.request();
		flag.reset();
		const afterReset = flag.consume();
		assert.deepStrictEqual([initiallyRequested, requested, firstConsume, secondConsume, afterReset], [false, true, true, false, false]);
	});

	test('условие сводки: принудительный флаг равен превышению бюджета, но малую историю не сворачивает', () => {
		assert.deepStrictEqual(
			[
				shouldBudgetFill({ forceCompact: true, beforeTokens: 100, budget: 1000, messageCount: BUDGET_FILL_MIN_MESSAGES + 1 }),
				shouldBudgetFill({ forceCompact: false, beforeTokens: 1001, budget: 1000, messageCount: BUDGET_FILL_MIN_MESSAGES + 1 }),
				shouldBudgetFill({ forceCompact: false, beforeTokens: 1000, budget: 1000, messageCount: BUDGET_FILL_MIN_MESSAGES + 1 }),
				shouldBudgetFill({ forceCompact: true, beforeTokens: 100, budget: 1000, messageCount: BUDGET_FILL_MIN_MESSAGES }),
			],
			[true, true, false, false],
		);
	});

	test('заготовка заметки называет, что сохранить, что выбросить и что сверить', () => {
		assert.deepStrictEqual(
			[DEFAULT_PRESERVE_NOTE.includes('Сохранить'), DEFAULT_PRESERVE_NOTE.includes('Выбросить'), DEFAULT_PRESERVE_NOTE.includes('бриф')],
			[true, true, true],
		);
	});
});
