/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	safeParseConfigJson,
	parseConfigJsonOrDefaults,
} from '../../common/vibeConfigJsonParser.js';

suite('VibeConfigJsonParser', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('safeParseConfigJson', () => {
		test('valid object → ok', () => {
			const r = safeParseConfigJson('{"a":1}');
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.deepStrictEqual(r.value, { a: 1 });
			}
		});

		test('JSONC line comments are stripped before parse', () => {
			const r = safeParseConfigJson('{ /* comment */ "a": 1, // tail\n "b": 2 }');
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.deepStrictEqual(r.value, { a: 1, b: 2 });
			}
		});

		test('undefined input → not-ok with reason "empty"', () => {
			const r = safeParseConfigJson(undefined);
			assert.strictEqual(r.ok, false);
			if (!r.ok) {
				assert.strictEqual(r.reason, 'empty');
			}
		});

		test('null input → not-ok with reason "empty"', () => {
			const r = safeParseConfigJson(null);
			assert.strictEqual(r.ok, false);
		});

		test('whitespace-only input → not-ok with reason "empty"', () => {
			const r = safeParseConfigJson('   \n\t  ');
			assert.strictEqual(r.ok, false);
		});

		test('malformed JSON → not-ok with json-parse reason', () => {
			const r = safeParseConfigJson('{ this is not json }');
			assert.strictEqual(r.ok, false);
			if (!r.ok) {
				assert.ok(r.reason.startsWith('json-parse:'), r.reason);
			}
		});

		test('JSON null root → not-ok with reason "null-root"', () => {
			const r = safeParseConfigJson('null');
			assert.strictEqual(r.ok, false);
			if (!r.ok) {
				assert.strictEqual(r.reason, 'null-root');
			}
		});

		test('validator rejection → not-ok with reason "validator-rejected"', () => {
			interface ConstraintsDoc { rules: unknown[] }
			const isConstraints = (v: unknown): v is ConstraintsDoc =>
				typeof v === 'object' && v !== null && Array.isArray((v as { rules?: unknown }).rules);
			const goodResult = safeParseConfigJson<ConstraintsDoc>('{"rules":[]}', isConstraints);
			const badResult = safeParseConfigJson<ConstraintsDoc>('{"oops":true}', isConstraints);
			assert.strictEqual(goodResult.ok, true);
			assert.strictEqual(badResult.ok, false);
			if (!badResult.ok) {
				assert.strictEqual(badResult.reason, 'validator-rejected');
			}
		});

		test('does not throw on adversarial input', () => {
			// The point of the helper is "never throws" — exercise some shapes that
			// historically broke ad-hoc parsers.
			assert.doesNotThrow(() => safeParseConfigJson('{"unterminated": "string'));
			assert.doesNotThrow(() => safeParseConfigJson('{"a": "b", '));
			assert.doesNotThrow(() => safeParseConfigJson('not-even-close'));
			assert.doesNotThrow(() => safeParseConfigJson(''));
		});
	});

	suite('parseConfigJsonOrDefaults', () => {
		const DEFAULTS = { rules: [] as unknown[] };

		test('returns parsed value on success', () => {
			const r = parseConfigJsonOrDefaults('{"rules":["one"]}', DEFAULTS);
			assert.deepStrictEqual(r, { rules: ['one'] });
		});

		test('returns defaults on parse failure and reports reason', () => {
			let reason: string | undefined;
			const r = parseConfigJsonOrDefaults('{ broken', DEFAULTS, r2 => { reason = r2; });
			assert.strictEqual(r, DEFAULTS);
			assert.ok(typeof reason === 'string' && reason.startsWith('json-parse:'), reason ?? '<no reason>');
		});

		test('returns defaults on validator rejection and reports reason', () => {
			const isShape = (v: unknown): v is typeof DEFAULTS =>
				typeof v === 'object' && v !== null && Array.isArray((v as { rules?: unknown }).rules);
			let reason: string | undefined;
			const r = parseConfigJsonOrDefaults('{"oops":true}', DEFAULTS, r2 => { reason = r2; }, isShape);
			assert.strictEqual(r, DEFAULTS);
			assert.strictEqual(reason, 'validator-rejected');
		});

		test('silent fallback (no callback) still returns defaults', () => {
			const r = parseConfigJsonOrDefaults('{ broken', DEFAULTS);
			assert.strictEqual(r, DEFAULTS);
		});
	});
});
