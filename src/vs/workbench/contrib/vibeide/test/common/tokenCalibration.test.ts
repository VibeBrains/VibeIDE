/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	updateTokenCalibration,
	clampTokenCalibration,
	serializeCalibration,
	deserializeCalibration,
	TOKEN_CALIBRATION_DEFAULT,
	TOKEN_CALIBRATION_ALPHA,
	TOKEN_CALIBRATION_MIN,
	TOKEN_CALIBRATION_MAX,
} from '../../common/tokenCalibration.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('tokenCalibration', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('updateTokenCalibration', () => {
		test('first sample seeds the factor with the raw ratio', () => {
			// real 1300, est 1000 → ratio 1.3, no prior → factor 1.3
			assert.strictEqual(updateTokenCalibration(undefined, 1300, 1000), 1.3);
		});

		test('subsequent samples blend via EWMA', () => {
			// prev 1.0, new ratio 2.0 → 1.0*(1-α) + 2.0*α
			const expected = 1.0 * (1 - TOKEN_CALIBRATION_ALPHA) + 2.0 * TOKEN_CALIBRATION_ALPHA;
			assert.strictEqual(updateTokenCalibration(1.0, 2000, 1000), expected);
		});

		test('ratio is clamped to the [MIN, MAX] band before blending', () => {
			// real 100000, est 1000 → ratio 100, clamped to MAX → first sample returns MAX
			assert.strictEqual(updateTokenCalibration(undefined, 100000, 1000), TOKEN_CALIBRATION_MAX);
			// real 10, est 1000 → ratio 0.01, clamped to MIN
			assert.strictEqual(updateTokenCalibration(undefined, 10, 1000), TOKEN_CALIBRATION_MIN);
		});

		test('non-positive / non-finite inputs return the prior factor unchanged', () => {
			assert.strictEqual(updateTokenCalibration(1.5, 0, 1000), 1.5);
			assert.strictEqual(updateTokenCalibration(1.5, 1000, 0), 1.5);
			assert.strictEqual(updateTokenCalibration(1.5, NaN, 1000), 1.5);
			assert.strictEqual(updateTokenCalibration(1.5, 1000, Infinity), 1.5);
		});

		test('bad input with no prior falls back to the default factor', () => {
			assert.strictEqual(updateTokenCalibration(undefined, 0, 0), TOKEN_CALIBRATION_DEFAULT);
		});

		test('a non-finite prior is treated as the first sample', () => {
			assert.strictEqual(updateTokenCalibration(NaN, 1200, 1000), 1.2);
		});
	});

	suite('clampTokenCalibration', () => {
		test('undefined / non-finite → default factor', () => {
			assert.strictEqual(clampTokenCalibration(undefined), TOKEN_CALIBRATION_DEFAULT);
			assert.strictEqual(clampTokenCalibration(NaN), TOKEN_CALIBRATION_DEFAULT);
		});

		test('in-band value passes through unchanged', () => {
			assert.strictEqual(clampTokenCalibration(1.4), 1.4);
		});

		test('out-of-band values are clamped', () => {
			assert.strictEqual(clampTokenCalibration(99), TOKEN_CALIBRATION_MAX);
			assert.strictEqual(clampTokenCalibration(0.01), TOKEN_CALIBRATION_MIN);
		});
	});

	suite('serialize / deserialize', () => {
		test('round-trips a map of factors', () => {
			const m = new Map<string, number>([['openCodeGo:deepseek-v4-pro', 1.3], ['anthropic:claude', 1.05]]);
			const restored = deserializeCalibration(serializeCalibration(m));
			assert.strictEqual(restored.get('openCodeGo:deepseek-v4-pro'), 1.3);
			assert.strictEqual(restored.get('anthropic:claude'), 1.05);
			assert.strictEqual(restored.size, 2);
		});

		test('serialize drops non-finite values', () => {
			const m = new Map<string, number>([['a', 1.2], ['b', NaN], ['c', Infinity]]);
			const obj = JSON.parse(serializeCalibration(m));
			assert.strictEqual(obj.a, 1.2);
			assert.ok(!Object.hasOwn(obj, 'b'));
			assert.ok(!Object.hasOwn(obj, 'c'));
		});

		test('deserialize returns empty map on undefined / garbage / wrong-type', () => {
			assert.strictEqual(deserializeCalibration(undefined).size, 0);
			assert.strictEqual(deserializeCalibration('not json{').size, 0);
			assert.strictEqual(deserializeCalibration('42').size, 0);
			assert.strictEqual(deserializeCalibration('null').size, 0);
		});

		test('deserialize clamps out-of-band stored values and drops bad entries', () => {
			const restored = deserializeCalibration('{"a":99,"b":0.01,"c":"x","d":1.4}');
			assert.strictEqual(restored.get('a'), TOKEN_CALIBRATION_MAX);
			assert.strictEqual(restored.get('b'), TOKEN_CALIBRATION_MIN);
			assert.ok(!restored.has('c')); // non-number dropped
			assert.strictEqual(restored.get('d'), 1.4);
		});
	});
});
