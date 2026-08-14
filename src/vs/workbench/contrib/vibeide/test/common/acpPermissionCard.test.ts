/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ACP_CARD_DIFF_LINES, allowOptionOf, formatAcpPermissionCard, formatAcpTurnEnd } from '../../common/acp/acpPermissionCard.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('acpPermissionCard', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('карточка называет агента, действие, файл и размер правки', () => {
		const card = formatAcpPermissionCard({
			agentName: 'Claude Code',
			title: 'Edit /app/hello.txt',
			paths: ['/app/hello.txt'],
			diffs: [{ path: '/app/hello.txt', oldText: 'привет мир', newText: 'привет друг' }],
		});
		assert.deepStrictEqual(
			[card.includes('Claude Code'), card.includes('Edit /app/hello.txt'), card.includes('/app/hello.txt'), card.includes('−1/+1 строк'), card.includes('− привет мир'), card.includes('+ привет друг')],
			[true, true, true, true, true, true]);
	});

	test('длинная правка обрезается и об этом сказано', () => {
		// Правка на двести строк, вываленная в чат, решение обоснованнее не делает.
		const long = Array.from({ length: 40 }, (_, index) => `строка ${index}`).join('\n');
		const card = formatAcpPermissionCard({
			agentName: 'Агент', title: 'Edit', paths: [], diffs: [{ path: '/app/big.ts', oldText: long, newText: long }],
		});
		const shownLines = card.split('\n').filter(line => line.startsWith('− ') || line.startsWith('+ '));
		assert.deepStrictEqual([shownLines.length, card.includes('Показано начало правки')], [ACP_CARD_DIFF_LINES * 2, true]);
	});

	test('много файлов сворачиваются в счётчик, а не в простыню', () => {
		const paths = Array.from({ length: 9 }, (_, index) => `/app/file${index}.ts`);
		const card = formatAcpPermissionCard({ agentName: 'Агент', title: 'Правка', paths, diffs: [] });
		assert.deepStrictEqual([card.includes('/app/file4.ts'), card.includes('/app/file8.ts'), card.includes('…и ещё 4')], [true, false, true]);
	});

	test('действие без правки файлов остаётся понятным', () => {
		const card = formatAcpPermissionCard({ agentName: 'Агент', title: '', paths: [], diffs: [] });
		assert.ok(card.includes('действие без названия'), card);
	});

	test('«разрешить» — это разовое согласие агента, а не «разрешать всегда»', () => {
		const options = [
			{ optionId: 'reject', kind: 'reject_once' },
			{ optionId: 'allow', kind: 'allow_once' },
			{ optionId: 'allow_always', kind: 'allow_always' },
		];
		assert.strictEqual(allowOptionOf(options), 'allow');
	});

	test('без разового согласия берётся постоянное, иначе разрешать нечем', () => {
		assert.deepStrictEqual(
			[allowOptionOf([{ optionId: 'always', kind: 'allow_always' }]), allowOptionOf([{ optionId: 'no', kind: 'reject_once' }])],
			['always', undefined]);
	});

	test('итог хода несёт причину и расход', () => {
		// Разряды `toLocaleString('ru-RU')` разделяет неразрывным пробелом; сверяем содержание,
		// а не то, каким именно пробелом среда разделила тысячи.
		const plain = (text: string): string => text.replace(/ /g, ' ');
		assert.deepStrictEqual(
			[
				plain(formatAcpTurnEnd('completed', { used: 30244, size: 1000000, costUsd: 0.1849 })),
				plain(formatAcpTurnEnd('cancelled', undefined)),
				plain(formatAcpTurnEnd(undefined, undefined)),
			],
			[
				'✅ Готово.\n30 244 / 1 000 000 токенов · $0.1849',
				'⛔️ Ход прерван.',
				'ход закончился',
			]);
	});
});
