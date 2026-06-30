/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyToolCallFormat, isAutoDowngradeInEffect } from '../../common/toolCallFormatStatus.js';

suite('toolCallFormatStatus', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const TTL = 7 * 24 * 60 * 60 * 1000;
	const NOW = 1_000_000_000_000;

	suite('classifyToolCallFormat', () => {
		test('auto selection wins regardless of other fields', () => {
			assert.strictEqual(classifyToolCallFormat({ isAutoSelection: true, specialToolFormat: 'openai-style', autoDetected: true, detectedAt: NOW, now: NOW, ttlMs: TTL }), 'auto');
		});

		test('specialToolFormat set → native', () => {
			assert.strictEqual(classifyToolCallFormat({ isAutoSelection: false, specialToolFormat: 'anthropic-style', autoDetected: false, detectedAt: undefined, now: NOW, ttlMs: TTL }), 'native');
		});

		test('no format, no override → xml', () => {
			assert.strictEqual(classifyToolCallFormat({ isAutoSelection: false, specialToolFormat: undefined, autoDetected: false, detectedAt: undefined, now: NOW, ttlMs: TTL }), 'xml');
		});

		test('no format + fresh auto-detected override → xml-autodowngraded', () => {
			assert.strictEqual(classifyToolCallFormat({ isAutoSelection: false, specialToolFormat: undefined, autoDetected: true, detectedAt: NOW - 1000, now: NOW, ttlMs: TTL }), 'xml-autodowngraded');
		});

		test('auto-detected override past TTL → plain xml (override no longer in effect)', () => {
			assert.strictEqual(classifyToolCallFormat({ isAutoSelection: false, specialToolFormat: undefined, autoDetected: true, detectedAt: NOW - TTL - 1, now: NOW, ttlMs: TTL }), 'xml');
		});

		test('autoDetected true but no detectedAt → plain xml (cannot age, treat as not-in-effect)', () => {
			assert.strictEqual(classifyToolCallFormat({ isAutoSelection: false, specialToolFormat: undefined, autoDetected: true, detectedAt: undefined, now: NOW, ttlMs: TTL }), 'xml');
		});

		test('null specialToolFormat behaves like undefined', () => {
			assert.strictEqual(classifyToolCallFormat({ isAutoSelection: false, specialToolFormat: null, autoDetected: false, detectedAt: undefined, now: NOW, ttlMs: TTL }), 'xml');
		});
	});

	suite('isAutoDowngradeInEffect', () => {
		test('within TTL → true', () => {
			assert.strictEqual(isAutoDowngradeInEffect(true, NOW - 1, NOW, TTL), true);
		});
		test('at/after TTL boundary → false', () => {
			assert.strictEqual(isAutoDowngradeInEffect(true, NOW - TTL, NOW, TTL), false);
		});
		test('not auto-detected → false', () => {
			assert.strictEqual(isAutoDowngradeInEffect(false, NOW - 1, NOW, TTL), false);
		});
		test('missing detectedAt → false', () => {
			assert.strictEqual(isAutoDowngradeInEffect(true, undefined, NOW, TTL), false);
		});
	});
});
