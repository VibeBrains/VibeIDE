/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SecretNoticeLedger, secretNoticeScopeOf, withRuleDisabled, withRuleEnabled } from '../../common/secretNotice.js';

/**
 * Уведомление «из сообщения модели скрыто похожее на секрет»: что кнопки пишут в настройку и когда правило
 * не называется повторно.
 *
 * Жалоба пользователя 14.10.2026: уведомление маячит на каждом шаге хода, а в настройке непонятно, что вписывать.
 */
suite('Уведомление о скрытом секрете', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('список выключенных правил', () => {

		test('выключение дописывает правило без дублей и не трогает вход', () => {
			const before = ['openai-key'];
			assert.deepStrictEqual({
				added: withRuleDisabled(before, 'password-pattern'),
				again: withRuleDisabled(['password-pattern', 'openai-key'], 'password-pattern'),
				fromEmpty: withRuleDisabled([], 'jwt-token'),
				before,
			}, {
				added: ['openai-key', 'password-pattern'],
				again: ['password-pattern', 'openai-key'],
				fromEmpty: ['jwt-token'],
				before: ['openai-key'],
			});
		});

		test('«Вернуть» убирает правило и оставляет остальные; повтор и отсутствующее безвредны', () => {
			const before = ['openai-key', 'password-pattern'];
			assert.deepStrictEqual({
				removed: withRuleEnabled(before, 'password-pattern'),
				absent: withRuleEnabled(before, 'jwt-token'),
				doubled: withRuleEnabled(['password-pattern', 'password-pattern', 'jwt-token'], 'password-pattern'),
				roundTrip: withRuleEnabled(withRuleDisabled(before, 'jwt-token'), 'jwt-token'),
				before,
			}, {
				removed: ['openai-key'],
				absent: ['openai-key', 'password-pattern'],
				doubled: ['jwt-token'],
				roundTrip: ['openai-key', 'password-pattern'],
				before: ['openai-key', 'password-pattern'],
			});
		});
	});

	suite('ход агента', () => {

		const user = { role: 'user' };
		const assistant = { role: 'assistant' };
		const tool = { role: 'tool' };
		const nudge = { role: 'user', isSyntheticNudge: true };

		test('ход считается по сообщениям человека: шаги цикла и подсказки агента его не меняют', () => {
			assert.deepStrictEqual({
				first: secretNoticeScopeOf('t1', [user]),
				afterToolSteps: secretNoticeScopeOf('t1', [user, assistant, tool, assistant, tool]),
				afterNudge: secretNoticeScopeOf('t1', [user, assistant, nudge]),
				nextMessage: secretNoticeScopeOf('t1', [user, assistant, user]),
				otherThread: secretNoticeScopeOf('t2', [user]),
			}, {
				first: 't1#1',
				afterToolSteps: 't1#1',
				afterNudge: 't1#1',
				nextMessage: 't1#2',
				otherThread: 't2#1',
			});
		});
	});

	suite('повтор уведомления', () => {

		test('правило называется один раз за ход, новое правило — отдельно', () => {
			const ledger = new SecretNoticeLedger();
			assert.deepStrictEqual([
				ledger.claim('t1#1', ['password-pattern']),
				ledger.claim('t1#1', ['password-pattern']),
				ledger.claim('t1#1', ['password-pattern', 'jwt-token']),
				ledger.claim('t1#1', ['jwt-token', 'password-pattern']),
			], [
				['password-pattern'],
				[],
				['jwt-token'],
				[],
			]);
		});

		test('следующий ход и другой тред называют то же правило заново', () => {
			const ledger = new SecretNoticeLedger();
			ledger.claim('t1#1', ['password-pattern']);
			assert.deepStrictEqual([
				ledger.claim('t1#2', ['password-pattern']),
				ledger.claim('t2#1', ['password-pattern']),
				ledger.claim('t1#1', ['password-pattern']),
			], [
				['password-pattern'],
				['password-pattern'],
				[],
			]);
		});

		test('без хода сравнивать не с чем: называется всё и каждый раз', () => {
			const ledger = new SecretNoticeLedger();
			assert.deepStrictEqual([
				ledger.claim(undefined, ['password-pattern']),
				ledger.claim(undefined, ['password-pattern']),
			], [
				['password-pattern'],
				['password-pattern'],
			]);
		});

		test('одно правило дважды в одном вызове называется один раз', () => {
			assert.deepStrictEqual(new SecretNoticeLedger().claim('t1#1', ['jwt-token', 'jwt-token']), ['jwt-token']);
		});

		test('память о ходах ограничена: самый старый забывается', () => {
			const ledger = new SecretNoticeLedger();
			ledger.claim('first', ['password-pattern']);
			for (let i = 0; i < 64; i++) {
				ledger.claim(`turn${i}`, ['password-pattern']);
			}
			assert.deepStrictEqual({
				forgotten: ledger.claim('first', ['password-pattern']),
				recent: ledger.claim('turn63', ['password-pattern']),
			}, {
				forgotten: ['password-pattern'],
				recent: [],
			});
		});
	});
});
