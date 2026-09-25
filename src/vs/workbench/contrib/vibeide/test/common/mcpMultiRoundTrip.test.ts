/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeUnansweredInput, parseInputRequired, withInputResponses } from '../../common/mcpMultiRoundTrip.js';

const state = { opaque: 'не наше дело' };

suite('mcpMultiRoundTrip — сервер просит ввод повтором запроса', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('результат без resultType завершён, input_required разбирается в просьбы', () => {
		assert.deepStrictEqual([
			parseInputRequired({ content: [{ type: 'text', text: 'готово' }] }),
			parseInputRequired({ resultType: 'complete', content: [] }),
			parseInputRequired({
				resultType: 'input_required',
				requestState: state,
				inputRequests: { ask: { method: 'elicitation/create', params: { message: 'Куда деплоим?' } }, broken: { params: {} } },
			}),
		], [
			undefined,
			undefined,
			{ requestState: state, inputRequests: [{ key: 'ask', method: 'elicitation/create', params: { message: 'Куда деплоим?' } }] },
		]);
	});

	/** Состояние сервера возвращается дословно: разбирать или пересобирать его спека запрещает. */
	test('повтор: ответы и состояние в params рядом с arguments; нет состояния или ответов — нет и поля', () => {
		const request = { name: 'deploy', arguments: { env: 'prod' } };
		const retry = withInputResponses(request, { ask: { value: 'staging' } }, state);
		assert.deepStrictEqual([
			retry,
			withInputResponses(request, { ask: { value: 'staging' } }, undefined),
			withInputResponses(request, {}, state),
		], [
			{ name: 'deploy', arguments: { env: 'prod' }, inputResponses: { ask: { value: 'staging' } }, requestState: state },
			{ name: 'deploy', arguments: { env: 'prod' }, inputResponses: { ask: { value: 'staging' } } },
			{ name: 'deploy', arguments: { env: 'prod' }, requestState: state },
		]);
		assert.strictEqual(retry.requestState, state);
	});

	test('отвечать нечем — модель получает объяснение, а не сбой на пустом результате', () => {
		assert.strictEqual(
			describeUnansweredInput('deploy', { requestState: state, inputRequests: [{ key: 'ask', method: 'elicitation/create', params: {} }] }),
			'Инструмент «deploy» не выполнен: сервер просит ввод (elicitation/create), а VibeIDE пока не умеет отвечать на такие просьбы. Спросите нужное у пользователя сами и вызовите инструмент повторно с готовыми значениями.',
		);
	});
});
