/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatQuotaSection, parseQuotaSpec } from '../../common/subscriptionQuota.js';

/**
 * Поле quota провайдера и раздел отчёта «Остаток подписки»: ответ вендора, а не свой подсчёт, и «нет данных» вместо 0.
 */
suite('subscriptionQuota — поле провайдера и раздел отчёта', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('поле quota: отсутствует, верное, http или незнакомый формат — битое', () => {
		assert.deepStrictEqual([
			parseQuotaSpec(undefined),
			parseQuotaSpec({ url: 'https://api.minimax.io/v1/token_plan/remains', format: 'minimax-token-plan' }),
			parseQuotaSpec({ url: 'http://api.minimax.io/v1/token_plan/remains', format: 'minimax-token-plan' }),
			parseQuotaSpec({ url: 'https://x/quota', format: 'guess' }),
			parseQuotaSpec('https://x'),
		], [undefined, { url: 'https://api.minimax.io/v1/token_plan/remains', format: 'minimax-token-plan' }, 'invalid', 'invalid', 'invalid']);
	});

	test('раздел отчёта: окна, безлимит, ошибка вендора, нечитаемый ответ, сбой запроса; без строк — без раздела', () => {
		const askedAt = Date.parse('2026-09-17T12:00:00Z');
		assert.deepStrictEqual(formatQuotaSection([], askedAt), []);
		assert.deepStrictEqual(formatQuotaSection([
			{ providerId: 'minimax', displayName: 'MiniMax', format: 'minimax-token-plan', outcome: { kind: 'answered', result: { kind: 'windows', windows: [
				{ scope: 'MiniMax-M*', windowMs: 18_000_000, leftPercent: 15, resetAtMs: Date.parse('2026-09-17T15:00:00Z') },
				{ scope: 'image-01', windowMs: 86_400_000, leftPercent: null, resetAtMs: null },
			] } } },
			{ providerId: 'zai', displayName: 'Z.ai', format: 'zai-monitor', outcome: { kind: 'answered', result: { kind: 'vendorError', message: 'token expired' } } },
			{ providerId: 'other', displayName: 'Другой', format: 'minimax-token-plan', outcome: { kind: 'answered', result: { kind: 'unreadable' } } },
			{ providerId: 'down', displayName: 'Недоступный', format: 'minimax-token-plan', outcome: { kind: 'failed', reason: 'timeout' } },
		], askedAt), [
			'## Остаток подписки', '', 'Ответ вендора, запрос в 2026-09-17 12:00 UTC. Остаток считает сам вендор — по своим правилам и с учётом расхода вне IDE.',
			'', '### MiniMax', '', '| Окно | Осталось | Сброс |', '|---|---|---|',
			'| MiniMax-M*, 5 ч | 15% | 2026-09-17 15:00 UTC |',
			'| image-01, 1 дн | без ограничения | — |',
			'', '### Z.ai', '', '_Этот запрос вендор не документирует — формат ответа может смениться без предупреждения._', '', 'Вендор ответил ошибкой: token expired',
			'', '### Другой', '', 'Ответ не удалось прочитать — данных нет.',
			'', '### Недоступный', '', 'Не удалось спросить: timeout',
		]);
	});
});
