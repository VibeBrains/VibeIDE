/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { acpToolStatusLabel, questionOfCall, splitAcpQuestions } from '../../common/acp/acpParallelPermissions.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('acpParallelPermissions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('вопрос стоит под своим вызовом, а без адреса, с пропавшим вызовом и повтор адреса — в общем блоке; pending различает вопрос', () => {
		const question = (requestId: string, toolCallId: string) => ({ request: { requestId, toolCallId }, reason: undefined });
		const questions = [
			question('q1', 'call-1'),
			question('q2', 'call-2'),
			question('q3', ''),
			question('q4', 'call-gone'),
			question('q5', 'call-1'),
		];
		const split = splitAcpQuestions(questions, ['call-1', 'call-2', 'call-3']);
		assert.deepStrictEqual({
			bound: split.bound.map(item => [item.toolCallId, item.question.request.requestId]),
			homeless: split.homeless.map(item => item.request.requestId),
			own: questionOfCall(questions, 'call-2')?.request.requestId,
			foreign: questionOfCall(questions, 'call-3'),
			emptyAddress: questionOfCall(questions, ''),
			waiting: acpToolStatusLabel('pending', true),
			queued: acpToolStatusLabel('pending', false),
			running: acpToolStatusLabel('in_progress', false),
			done: acpToolStatusLabel('completed', false),
			failed: acpToolStatusLabel('failed', false),
			cancelled: acpToolStatusLabel('cancelled', false),
			unknown: acpToolStatusLabel('unknown', false),
			unheard: acpToolStatusLabel('новая-стадия', false),
		}, {
			bound: [['call-1', 'q1'], ['call-2', 'q2']],
			homeless: ['q3', 'q4', 'q5'],
			own: 'q2',
			foreign: undefined,
			emptyAddress: undefined,
			waiting: 'ждёт разрешения',
			queued: 'в очереди',
			running: 'идёт',
			done: 'готово',
			failed: 'ошибка',
			cancelled: 'отменено',
			unknown: 'идёт',
			unheard: undefined,
		});
	});
});
