/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	MetricDirection,
	OptimizationVerdict,
	bestValue,
	consecutiveFailures,
	decideOptimization,
	formatImprovement,
	readMeasurement,
	type IOptimizationAttempt,
} from '../../common/metricOptimization.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const attempt = (verdict: OptimizationVerdict, value?: number): IOptimizationAttempt =>
	({ attempt: 1, summary: 'проба', verdict, value });

suite('metricOptimization', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('readMeasurement', () => {
		test('число последней строкой, с единицами и без', () => {
			assert.deepStrictEqual(
				['12.4', 'сборка ок\n89ms', '0.5 s', '-3'].map(stdout =>
					readMeasurement({ stdout, contract: { kind: 'lastLine' } })),
				[
					{ ok: true, value: 12.4 },
					{ ok: true, value: 89 },
					{ ok: true, value: 0.5 },
					{ ok: true, value: -3 },
				]);
		});

		test('поле JSON по точечному пути', () => {
			const stdout = JSON.stringify({ results: { mean: 42.5, runs: 10 } });
			assert.deepStrictEqual(
				readMeasurement({ stdout, contract: { kind: 'jsonField', path: 'results.mean' } }),
				{ ok: true, value: 42.5 });
		});

		test('нечитаемый замер отличим от плохого результата', () => {
			const cases = [
				readMeasurement({ stdout: '', contract: { kind: 'lastLine' } }),
				readMeasurement({ stdout: 'всё готово', contract: { kind: 'lastLine' } }),
				readMeasurement({ stdout: 'не json', contract: { kind: 'jsonField', path: 'x' } }),
				readMeasurement({ stdout: '{"a":1}', contract: { kind: 'jsonField', path: 'b' } }),
				readMeasurement({ stdout: '{"a":"текст"}', contract: { kind: 'jsonField', path: 'a' } }),
			];
			assert.deepStrictEqual(cases.map(c => c.ok), [false, false, false, false, false]);
			assert.ok(cases.every(c => !c.ok && c.reason.length > 0), 'у каждого отказа есть причина');
		});

		test('разделитель тысяч не толкуется молча — иначе ошибка в тысячу раз', () => {
			assert.strictEqual(readMeasurement({ stdout: '1,234', contract: { kind: 'lastLine' } }).ok, false);
		});
	});

	suite('decideOptimization', () => {
		const lower = (baseline: number, candidate: number, noiseThreshold = 0.02) =>
			decideOptimization({ baseline, candidate, direction: MetricDirection.Lower, noiseThreshold });

		test('меньше — лучше: снижение оставляем, рост откатываем', () => {
			assert.deepStrictEqual(
				[lower(100, 80).verdict, lower(100, 120).verdict],
				[OptimizationVerdict.Keep, OptimizationVerdict.Discard]);
		});

		test('больше — лучше: направление переворачивает вердикт, а не арифметику', () => {
			const higher = (baseline: number, candidate: number) =>
				decideOptimization({ baseline, candidate, direction: MetricDirection.Higher, noiseThreshold: 0.02 });
			assert.deepStrictEqual(
				[higher(50, 60).verdict, higher(50, 40).verdict],
				[OptimizationVerdict.Keep, OptimizationVerdict.Discard]);
		});

		test('изменение в пределах шума откатывается, а не празднуется', () => {
			assert.strictEqual(lower(100, 99).verdict, OptimizationVerdict.Noise);
		});

		test('порог шума настраивается: то же изменение при меньшем пороге уже значимо', () => {
			assert.strictEqual(lower(100, 99, 0.005).verdict, OptimizationVerdict.Keep);
		});

		test('улучшение положительно при любом направлении', () => {
			assert.deepStrictEqual(
				[
					lower(100, 80).improvement,
					decideOptimization({ baseline: 50, candidate: 60, direction: MetricDirection.Higher, noiseThreshold: 0.02 }).improvement,
				],
				[20, 10]);
		});

		test('нулевая база: доля не определена, поэтому любое изменение значимо', () => {
			assert.deepStrictEqual(
				[lower(0, 0).verdict, lower(0, 5).verdict, lower(0, -5).verdict],
				[OptimizationVerdict.Noise, OptimizationVerdict.Discard, OptimizationVerdict.Keep]);
		});
	});

	suite('ход прогона', () => {
		test('серия неудач считается с конца и обнуляется удачей', () => {
			assert.deepStrictEqual(
				[
					consecutiveFailures([]),
					consecutiveFailures([attempt(OptimizationVerdict.Discard), attempt(OptimizationVerdict.Noise)]),
					consecutiveFailures([attempt(OptimizationVerdict.Discard), attempt(OptimizationVerdict.Keep, 1)]),
				],
				[0, 2, 0]);
		});

		test('лучшее значение берётся только из удержанных попыток', () => {
			const attempts = [
				attempt(OptimizationVerdict.Keep, 80),
				attempt(OptimizationVerdict.Discard, 10), // лучше всех, но откачено — не в счёт
				attempt(OptimizationVerdict.Keep, 70),
			];
			assert.strictEqual(bestValue(100, attempts, MetricDirection.Lower), 70);
		});

		test('без удержанных попыток лучшее — это база', () => {
			assert.strictEqual(bestValue(100, [attempt(OptimizationVerdict.Discard, 50)], MetricDirection.Lower), 100);
		});
	});

	test('formatImprovement — знак со стороны пользы', () => {
		assert.deepStrictEqual(
			[formatImprovement(0.124), formatImprovement(-0.03), formatImprovement(Infinity)],
			['+12,4 %', '−3,0 %', '+∞']);
	});
});
