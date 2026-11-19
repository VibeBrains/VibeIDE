/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	firstTokenTimeoutMs,
	FIRST_TOKEN_CEILING_MS,
	FIRST_TOKEN_FLOOR_MS,
	FIRST_TOKEN_HISTORY_FACTOR,
	FIRST_TOKEN_MS_PER_PROMPT_STEP,
	FIRST_TOKEN_PROMPT_STEP_TOKENS,
} from '../../common/firstTokenTimeout.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('First token timeout (watchdog threshold before the first fragment)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty history and a small prompt keep the floor', () => {
		assert.deepStrictEqual(
			firstTokenTimeoutMs({
				promptTokensEstimate: 10_000,
				observedFirstTokenMs: [],
				floorMs: FIRST_TOKEN_FLOOR_MS,
				ceilingMs: FIRST_TOKEN_CEILING_MS,
			}),
			FIRST_TOKEN_FLOOR_MS,
		);
	});

	test('a request below the first 50k tokens adds nothing', () => {
		assert.deepStrictEqual(
			firstTokenTimeoutMs({
				promptTokensEstimate: 50_000,
				observedFirstTokenMs: [],
				floorMs: FIRST_TOKEN_FLOOR_MS,
				ceilingMs: FIRST_TOKEN_CEILING_MS,
			}),
			FIRST_TOKEN_FLOOR_MS,
		);
	});

	test('a large context adds 10 s per each 50k tokens beyond the first 50k', () => {
		assert.deepStrictEqual(
			firstTokenTimeoutMs({
				promptTokensEstimate: 50_000 + 2 * FIRST_TOKEN_PROMPT_STEP_TOKENS + 1,
				observedFirstTokenMs: [],
				floorMs: FIRST_TOKEN_FLOOR_MS,
				ceilingMs: FIRST_TOKEN_CEILING_MS,
			}),
			FIRST_TOKEN_FLOOR_MS + 2 * FIRST_TOKEN_MS_PER_PROMPT_STEP,
		);
	});

	test('a model observed at 40 s is not cut before 1.5x that', () => {
		assert.deepStrictEqual(
			firstTokenTimeoutMs({
				promptTokensEstimate: 10_000,
				observedFirstTokenMs: [6_000, 17_000, 40_000],
				floorMs: FIRST_TOKEN_FLOOR_MS,
				ceilingMs: FIRST_TOKEN_CEILING_MS,
			}),
			40_000 * FIRST_TOKEN_HISTORY_FACTOR,
		);
	});

	test('the hard-stall ceiling caps both growth and history', () => {
		assert.deepStrictEqual(
			firstTokenTimeoutMs({
				promptTokensEstimate: 1_000_000,
				observedFirstTokenMs: [400_000],
				floorMs: FIRST_TOKEN_FLOOR_MS,
				ceilingMs: 120_000,
			}),
			120_000,
		);
	});
});
