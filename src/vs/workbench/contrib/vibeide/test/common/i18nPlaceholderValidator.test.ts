/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	extractPlaceholders,
	validatePlaceholderParity,
	validateBundlePlaceholders,
} from '../../common/i18nPlaceholderValidator.js';

suite('i18n placeholder validator (506 / 507)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('extractPlaceholders', () => {
		test('extracts {0} {1} {2}', () => {
			assert.deepStrictEqual(extractPlaceholders('{0} foo {1} bar {2}'), [0, 1, 2]);
		});

		test('handles duplicates', () => {
			assert.deepStrictEqual(extractPlaceholders('{0} {0} {1}'), [0, 0, 1]);
		});

		test('handles non-sequential numbers', () => {
			assert.deepStrictEqual(extractPlaceholders('{5} foo {2}'), [5, 2]);
		});

		test('empty for plain string', () => {
			assert.deepStrictEqual(extractPlaceholders('plain'), []);
		});

		test('empty for non-string', () => {
			assert.deepStrictEqual(extractPlaceholders(null as unknown as string), []);
		});

		test('ignores {abc} non-numeric', () => {
			assert.deepStrictEqual(extractPlaceholders('{abc} {0}'), [0]);
		});
	});

	suite('validatePlaceholderParity', () => {
		test('parity → null', () => {
			assert.strictEqual(validatePlaceholderParity('k', '{0} foo {1}', '{0} foo {1}'), null);
		});

		test('different order is fine', () => {
			assert.strictEqual(validatePlaceholderParity('k', '{0} {1}', '{1} {0}'), null);
		});

		test('missing placeholder → missing-placeholder', () => {
			const v = validatePlaceholderParity('k', '{0} foo {1}', 'just zero {0}');
			assert.strictEqual(v?.kind, 'missing-placeholder');
			assert.deepStrictEqual(v?.missingPlaceholders, ['{1}']);
		});

		test('extra placeholder → extra-placeholder', () => {
			const v = validatePlaceholderParity('k', '{0}', '{0} {1}');
			assert.strictEqual(v?.kind, 'extra-placeholder');
			assert.deepStrictEqual(v?.extraPlaceholders, ['{1}']);
		});

		test('duplicate placeholder → duplicate-placeholder', () => {
			const v = validatePlaceholderParity('k', '{0}', '{0} {0}');
			assert.strictEqual(v?.kind, 'duplicate-placeholder');
		});

		test('source has duplicate, translation has same → ok', () => {
			assert.strictEqual(validatePlaceholderParity('k', '{0} {0}', '{0} {0}'), null);
		});

		test('translation with FEWER duplicates is missing-placeholder', () => {
			const v = validatePlaceholderParity('k', '{0} {0}', '{0}');
			assert.strictEqual(v?.kind, 'missing-placeholder');
		});
	});

	suite('validateBundlePlaceholders', () => {
		test('empty bundles → empty result', () => {
			assert.deepStrictEqual(validateBundlePlaceholders({}, {}), { checked: 0, ok: 0, violations: [] });
		});

		test('parity → no violations', () => {
			const r = validateBundlePlaceholders(
				{ a: '{0} hello', b: 'plain' },
				{ a: '{0} привет', b: 'обычный' },
			);
			assert.strictEqual(r.violations.length, 0);
			assert.strictEqual(r.ok, 2);
		});

		test('translation has missing placeholder → flagged', () => {
			const r = validateBundlePlaceholders(
				{ a: '{0} hello {1}' },
				{ a: 'привет {0}' },
			);
			assert.strictEqual(r.violations.length, 1);
			assert.strictEqual(r.violations[0].kind, 'missing-placeholder');
		});

		test('translation has extra key with placeholder → extra-placeholder', () => {
			const r = validateBundlePlaceholders(
				{},
				{ orphan: '{0} обр' },
			);
			assert.strictEqual(r.violations.length, 1);
			assert.strictEqual(r.violations[0].kind, 'extra-placeholder');
		});

		test('source-only key (no translation) is silently skipped', () => {
			const r = validateBundlePlaceholders(
				{ a: '{0}' },
				{},
			);
			assert.strictEqual(r.violations.length, 0);
			assert.strictEqual(r.checked, 1);
		});

		test('multiple keys mixed', () => {
			const r = validateBundlePlaceholders(
				{ ok: '{0}', bad: '{0} {1}' },
				{ ok: '{0}', bad: '{0}' },
			);
			assert.strictEqual(r.violations.length, 1);
			assert.strictEqual(r.violations[0].key, 'bad');
		});
	});
});
