/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	pseudoLocalise,
	looksPseudoLocalised,
	findEnglishLeaksInSnapshot,
	stripPseudoLocaleEnvelope,
	countPlaceholdersPreserved,
} from '../../common/pseudoLocaleTransform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('qps-ploc pseudo-locale transform', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('pseudoLocalise', () => {
		test('wraps with envelope', () => {
			const r = pseudoLocalise('example');
			assert.ok(r.startsWith('[!!_'));
			assert.ok(r.endsWith('_!!]'));
		});

		test('alternate-case inner letters', () => {
			const r = pseudoLocalise('example');
			// inner = "eXaMpLe" (lowercase, then uppercase, alternating)
			const inner = stripPseudoLocaleEnvelope(r);
			assert.strictEqual(inner, 'eXaMpLe');
		});

		test('preserves placeholders verbatim', () => {
			const r = pseudoLocalise('Hello {0}');
			assert.ok(r.includes('{0}'));
		});

		test('alternate-case skips placeholders for letter counting', () => {
			const r = pseudoLocalise('greet {0} world');
			// placeholder doesn't disrupt — letters of "greet" + "world" alternate
			const inner = stripPseudoLocaleEnvelope(r);
			assert.ok(inner !== null && inner.includes('{0}'));
		});

		test('preserves leading/trailing whitespace', () => {
			const r = pseudoLocalise('  hi  ');
			assert.ok(r.startsWith('  '));
			assert.ok(r.endsWith('  '));
		});

		test('empty string passthrough', () => {
			assert.strictEqual(pseudoLocalise(''), '');
		});

		test('whitespace-only passthrough', () => {
			assert.strictEqual(pseudoLocalise('   '), '   ');
		});

		test('numbers and symbols passed through unchanged', () => {
			const r = pseudoLocalise('Cost: $1,234');
			assert.ok(r.includes('$1,234'));
		});

		test('preservePlaceholders=false → placeholder gets cased', () => {
			const r = pseudoLocalise('a {0} b', { preservePlaceholders: false });
			// without preservation, {0} is treated as regular chars
			const inner = stripPseudoLocaleEnvelope(r);
			assert.ok(inner !== null);
		});

		test('addBrackets=false → no envelope', () => {
			const r = pseudoLocalise('example', { addBrackets: false });
			assert.ok(!r.startsWith('['));
			assert.strictEqual(r, 'eXaMpLe');
		});

		test('non-string → empty', () => {
			assert.strictEqual(pseudoLocalise(undefined as unknown as string), '');
		});

		test('preserves ${name} ICU-style tokens', () => {
			const r = pseudoLocalise('Hi ${name}!');
			assert.ok(r.includes('${name}'));
		});

		test('preserves <tags> in markup', () => {
			const r = pseudoLocalise('Click <a>here</a>');
			assert.ok(r.includes('<a>'));
			assert.ok(r.includes('</a>'));
		});
	});

	suite('looksPseudoLocalised', () => {
		test('true for envelope-wrapped', () => {
			assert.strictEqual(looksPseudoLocalised('[!!_eXaMpLe_!!]'), true);
		});

		test('true with surrounding whitespace', () => {
			assert.strictEqual(looksPseudoLocalised('  [!!_x_!!]  '), true);
		});

		test('false for plain English', () => {
			assert.strictEqual(looksPseudoLocalised('Hello'), false);
		});

		test('false for partial markers', () => {
			assert.strictEqual(looksPseudoLocalised('[!!_only_left'), false);
			assert.strictEqual(looksPseudoLocalised('[ no markers ]'), false);
		});

		test('false for empty / whitespace', () => {
			assert.strictEqual(looksPseudoLocalised(''), false);
			assert.strictEqual(looksPseudoLocalised('   '), false);
		});

		test('false for non-string', () => {
			assert.strictEqual(looksPseudoLocalised(42 as unknown as string), false);
		});
	});

	suite('findEnglishLeaksInSnapshot', () => {
		test('reports plain English strings', () => {
			const r = findEnglishLeaksInSnapshot([
				'[!!_oK_!!]',
				'Cancel', // leak
				'[!!_eXit_!!]',
			]);
			assert.deepStrictEqual(r, ['Cancel']);
		});

		test('skips empty / whitespace', () => {
			const r = findEnglishLeaksInSnapshot(['', '   ', '[!!_x_!!]']);
			assert.deepStrictEqual(r, []);
		});

		test('skips pure-numeric / symbolic', () => {
			const r = findEnglishLeaksInSnapshot(['1234', '...', '/', '   3   ']);
			assert.deepStrictEqual(r, []);
		});

		test('all properly localised → no leaks', () => {
			const r = findEnglishLeaksInSnapshot(['[!!_a_!!]', '[!!_b_!!]']);
			assert.deepStrictEqual(r, []);
		});

		test('all leaks reported in input order', () => {
			const r = findEnglishLeaksInSnapshot(['First', 'Second', 'Third']);
			assert.deepStrictEqual(r, ['First', 'Second', 'Third']);
		});

		test('non-string entries silently dropped', () => {
			const r = findEnglishLeaksInSnapshot(['leak', null as unknown as string, 'also-leak']);
			assert.deepStrictEqual(r, ['leak', 'also-leak']);
		});
	});

	suite('stripPseudoLocaleEnvelope', () => {
		test('returns inner', () => {
			assert.strictEqual(stripPseudoLocaleEnvelope('[!!_eXaMpLe_!!]'), 'eXaMpLe');
		});

		test('null when no envelope', () => {
			assert.strictEqual(stripPseudoLocaleEnvelope('plain'), null);
		});

		test('non-string → null', () => {
			assert.strictEqual(stripPseudoLocaleEnvelope(undefined as unknown as string), null);
		});
	});

	suite('countPlaceholdersPreserved', () => {
		test('counts {N} placeholders', () => {
			assert.strictEqual(countPlaceholdersPreserved('a {0} b {1} c'), 2);
		});

		test('zero when none', () => {
			assert.strictEqual(countPlaceholdersPreserved('plain'), 0);
		});

		test('counts duplicates', () => {
			assert.strictEqual(countPlaceholdersPreserved('a {0} b {0}'), 2);
		});
	});
});
