/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	collectDeclaredNames,
	extractReplaceSides,
	findReinventedComponents,
	normaliseComponentName,
	renderReinventedWarning,
} from '../../common/designContext/reinventedComponents.js';

suite('reinventedComponents — компонент заведён заново', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const existing = ['.card', '.btn', 'EmptyState', '--color-accent'];

	test('вариант того же компонента находится по основе имени', () => {
		assert.deepStrictEqual(
			findReinventedComponents('.card-wrapper { padding: 8px } .my-btn { color: red }', existing),
			[
				{ declared: '.card-wrapper', existing: '.card' },
				{ declared: '.my-btn', existing: '.btn' },
			],
		);
	});

	test('правка существующего имени — это норма, а не находка', () => {
		// Иначе предупреждение сработало бы на каждой законной правке и его перестали бы читать.
		assert.deepStrictEqual(findReinventedComponents('.card { padding: 16px }', existing), []);
	});

	test('BEM-модификатор — состояние базового класса, а не новое имя', () => {
		assert.deepStrictEqual(findReinventedComponents('.btn--ghost { opacity: .7 }', existing), []);
	});

	test('действительно новый компонент проходит молча', () => {
		// Узкий критерий важнее полноты: агент, одёрнутый на законном имени, перестанет читать
		// предупреждение вообще.
		assert.deepStrictEqual(findReinventedComponents('.pricing-table { width: 100% }', existing), []);
	});

	test('React-компонент сопоставляется с картой так же, как класс', () => {
		assert.deepStrictEqual(
			findReinventedComponents('export function EmptyStateNew() { return null }', existing),
			[{ declared: 'EmptyStateNew', existing: 'EmptyState' }],
		);
	});

	test('объявлением считается селектор с блоком правил, а не всякое упоминание класса', () => {
		// `className="card-wrapper"` — использование существующего класса, ничего не объявляет.
		assert.deepStrictEqual(collectDeclaredNames('<div className="card-wrapper">'), []);
		assert.deepStrictEqual(collectDeclaredNames('.card-wrapper { color: red }'), ['.card-wrapper']);
	});

	test('нормализация схлопывает обвязки и разделители', () => {
		assert.deepStrictEqual(
			['.card', 'Card', '.card-wrapper', '.CardContainer', '.card__title', '.btn--ghost', '.new-card-v2']
				.map(normaliseComponentName),
			['card', 'card', 'card', 'card', 'card', 'btn', 'card'],
		);
	});

	test('пустой ввод и пустая карта — молчание, а не пустое предупреждение', () => {
		assert.deepStrictEqual(findReinventedComponents('', existing), []);
		assert.deepStrictEqual(findReinventedComponents('.card-wrapper {}', []), []);
		assert.strictEqual(renderReinventedWarning([], '.vibe/design/uiKit.md'), '');
	});

	test('предупреждение называет конкретную замену и путь к карте', () => {
		const text = renderReinventedWarning([{ declared: '.card-wrapper', existing: '.card' }], '.vibe/design/uiKit.md');
		assert.ok(text.includes('`.card-wrapper` — в проекте уже есть `.card`'), text);
		assert.ok(text.includes('.vibe/design/uiKit.md'), text);
	});

	test('из блоков правки берётся только добавляемая половина', () => {
		// Половина ORIGINAL — существующий код: объявления в ней принадлежат уже написанному, и
		// считать их изобретением заново значит ругаться на каждую правку рядом с чужим классом.
		const blocks = [
			'<<<<<<< ORIGINAL',
			'.card { padding: 8px }',
			'=======',
			'.card-wrapper { padding: 12px }',
			'>>>>>>> UPDATED',
		].join('\n');
		assert.strictEqual(extractReplaceSides(blocks).trim(), '.card-wrapper { padding: 12px }');
	});

	test('несколько блоков собираются вместе, ORIGINAL не протекает', () => {
		const blocks = [
			'<<<<<<< ORIGINAL', '.a {}', '=======', '.one {}', '>>>>>>> UPDATED',
			'<<<<<<< ORIGINAL', '.b {}', '=======', '.two {}', '>>>>>>> UPDATED',
		].join('\n');
		const added = extractReplaceSides(blocks);
		assert.deepStrictEqual(collectDeclaredNames(added).sort(), ['.one', '.two']);
	});

	test('оборванный блок отдаёт то, что успело прийти', () => {
		// Такая правка всё равно не применится, но терять уже прочитанное незачем.
		const blocks = '<<<<<<< ORIGINAL\n.card {}\n=======\n.card-wrapper {}';
		assert.strictEqual(extractReplaceSides(blocks).trim(), '.card-wrapper {}');
	});
});
