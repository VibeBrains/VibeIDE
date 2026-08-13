/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeReviewAnnotation } from '../../common/codeReviewService.js';
import { describeAgreement, mergeReviewAnnotations } from '../../common/reviewFindingMerge.js';

const ann = (over: Partial<CodeReviewAnnotation> & { line: number }): CodeReviewAnnotation => ({
	id: `a${over.line}`,
	severity: 'warning',
	category: 'security',
	message: 'что-то не так',
	...over,
});

suite('reviewFindingMerge — согласие нескольких моделей', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('одна строка и категория у разных моделей — одна находка с двумя авторами', () => {
		const merged = mergeReviewAnnotations([
			{ model: 'A', annotations: [ann({ line: 10, message: 'SQL-инъекция' })] },
			{ model: 'B', annotations: [ann({ line: 10, message: 'неэкранированный ввод в запрос' })] },
		], 2);
		assert.deepStrictEqual(
			[merged.length, merged[0].agreedBy, merged[0].otherMessages],
			[1, ['A', 'B'], ['неэкранированный ввод в запрос']],
		);
	});

	test('находка одной модели из трёх отсеивается порогом', () => {
		const merged = mergeReviewAnnotations([
			{ model: 'A', annotations: [ann({ line: 5 }), ann({ line: 7 })] },
			{ model: 'B', annotations: [ann({ line: 5 })] },
			{ model: 'C', annotations: [ann({ line: 5 })] },
		], 2);
		assert.deepStrictEqual(merged.map(m => m.line), [5]);
	});

	test('единственный прогон порогом НЕ режется — иначе «нет находок» соврало бы про «чисто»', () => {
		const merged = mergeReviewAnnotations([{ model: 'A', annotations: [ann({ line: 3 })] }], 2);
		assert.deepStrictEqual([merged.length, merged[0].agreedBy], [1, ['A']]);
	});

	test('тяжесть берётся максимальная из названных, а не последняя', () => {
		const merged = mergeReviewAnnotations([
			{ model: 'A', annotations: [ann({ line: 4, severity: 'hint' })] },
			{ model: 'B', annotations: [ann({ line: 4, severity: 'error' })] },
		], 1);
		assert.strictEqual(merged[0].severity, 'error');
	});

	test('одна модель, назвавшая строку дважды, не создаёт согласия сама с собой', () => {
		const merged = mergeReviewAnnotations([
			{ model: 'A', annotations: [ann({ line: 9, message: 'раз' }), ann({ line: 9, message: 'два' })] },
		], 1);
		assert.deepStrictEqual([merged[0].agreedBy, merged[0].otherMessages], [['A'], ['два']]);
	});

	test('готовая правка подбирается у того, кто её дал', () => {
		const merged = mergeReviewAnnotations([
			{ model: 'A', annotations: [ann({ line: 2 })] },
			{ model: 'B', annotations: [ann({ line: 2, suggestedFix: 'экранировать' })] },
		], 1);
		assert.strictEqual(merged[0].suggestedFix, 'экранировать');
	});

	test('разные категории на одной строке — разные находки', () => {
		const merged = mergeReviewAnnotations([
			{ model: 'A', annotations: [ann({ line: 6, category: 'security' }), ann({ line: 6, category: 'performance' })] },
		], 1);
		assert.deepStrictEqual(merged.map(m => m.category).sort(), ['performance', 'security']);
	});

	test('порядок детерминирован: сначала согласие, потом тяжесть, потом строка', () => {
		const merged = mergeReviewAnnotations([
			{ model: 'A', annotations: [ann({ line: 30, severity: 'error' }), ann({ line: 20 })] },
			{ model: 'B', annotations: [ann({ line: 20 })] },
		], 1);
		assert.deepStrictEqual(merged.map(m => m.line), [20, 30]);
	});

	test('строка о согласии молчит на единственном прогоне и называет числа на нескольких', () => {
		const one = mergeReviewAnnotations([{ model: 'A', annotations: [ann({ line: 1 })] }], 1);
		const two = mergeReviewAnnotations([
			{ model: 'A', annotations: [ann({ line: 1 })] },
			{ model: 'B', annotations: [ann({ line: 1 })] },
		], 1);
		assert.deepStrictEqual(
			[describeAgreement(one[0], 1), describeAgreement(two[0], 2)],
			['', 'согласие 2/2 (A, B)'],
		);
	});
});
