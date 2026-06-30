/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	ZERO_WIDTH_CHARS,
	ZERO_WIDTH_BUNDLE,
	BIDI_CHARS,
	TROJAN_SOURCE_CANARY,
	HOMOGLYPH_PAIRS,
	SECRET_CANARIES,
	PROMPT_INJECTION_PATTERNS,
	interleaveZeroWidth,
	findUnsafeInvisibleChars,
	findSecretCanaries,
} from './securityTestFixtures.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('securityTestFixtures', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('ZERO_WIDTH_CHARS', () => {
		test('every entry is a single codepoint (some BMP, some not)', () => {
			for (const [name, char] of Object.entries(ZERO_WIDTH_CHARS)) {
				assert.ok(char.length === 1 || char.length === 2, `${name}: expected 1-2 UTF-16 units, got ${char.length}`);
			}
		});

		test('all entries pass through findUnsafeInvisibleChars', () => {
			for (const [name, char] of Object.entries(ZERO_WIDTH_CHARS)) {
				const found = findUnsafeInvisibleChars(char);
				assert.strictEqual(found.length, 1, `${name}: should have been flagged`);
			}
		});

		test('ZERO_WIDTH_BUNDLE concatenates every entry', () => {
			const distinctChars = new Set([...ZERO_WIDTH_BUNDLE]);
			assert.ok(distinctChars.size >= Object.keys(ZERO_WIDTH_CHARS).length - 1);
		});
	});

	suite('BIDI_CHARS', () => {
		test('rightToLeftOverride is U+202E (the Trojan Source vector)', () => {
			assert.strictEqual(BIDI_CHARS.rightToLeftOverride.codePointAt(0), 0x202E);
		});

		test('TROJAN_SOURCE_CANARY contains the RLO character', () => {
			assert.ok(TROJAN_SOURCE_CANARY.includes(BIDI_CHARS.rightToLeftOverride));
		});

		test('TROJAN_SOURCE_CANARY is flagged by findUnsafeInvisibleChars', () => {
			const offending = findUnsafeInvisibleChars(TROJAN_SOURCE_CANARY);
			assert.ok(offending.length >= 1);
			assert.strictEqual(offending[0].codepoint, 'U+202E');
		});
	});

	suite('HOMOGLYPH_PAIRS', () => {
		test('every pair has distinct UTF-16 representation', () => {
			for (const p of HOMOGLYPH_PAIRS) {
				assert.notStrictEqual(p.latin, p.confusable, `${p.reason}: must differ`);
			}
		});

		test('all confusables are non-Latin', () => {
			for (const p of HOMOGLYPH_PAIRS) {
				const cp = p.confusable.codePointAt(0)!;
				assert.ok(cp >= 0x0080, `${p.reason}: should be non-ASCII`);
			}
		});

		test('NFKC does NOT normalise these to Latin (so safelist must do it explicitly)', () => {
			// This test documents the design assumption — if a future Unicode update
			// adds NFKC normalisation for these, the policy needs to change.
			for (const p of HOMOGLYPH_PAIRS) {
				assert.notStrictEqual(p.confusable.normalize('NFKC'), p.latin);
			}
		});
	});

	suite('SECRET_CANARIES', () => {
		test('every canary contains the substring "CANARY" (or close variant)', () => {
			for (const [name, canary] of Object.entries(SECRET_CANARIES)) {
				assert.ok(/CANARY/i.test(canary) || /CANARW/i.test(canary), `${name}: should be tagged for traceability`);
			}
		});

		test('githubPat starts with ghp_', () => {
			assert.ok(SECRET_CANARIES.githubPat.startsWith('ghp_'));
		});

		test('openaiKey starts with sk-', () => {
			assert.ok(SECRET_CANARIES.openaiKey.startsWith('sk-'));
		});

		test('jwt has three dot-separated parts', () => {
			assert.strictEqual(SECRET_CANARIES.jwt.split('.').length, 3);
		});

		test('bearerHeader contains "Authorization: Bearer"', () => {
			assert.match(SECRET_CANARIES.bearerHeader, /^Authorization:\s+Bearer\s+/);
		});
	});

	suite('PROMPT_INJECTION_PATTERNS', () => {
		test('contains the canonical "IGNORE ALL PREVIOUS" string', () => {
			assert.ok(PROMPT_INJECTION_PATTERNS.some(p => p.includes('IGNORE ALL PREVIOUS')));
		});

		test('contains a system-tag inversion variant', () => {
			assert.ok(PROMPT_INJECTION_PATTERNS.some(p => /<\/system>[\s\S]*<system>/.test(p)));
		});

		test('every pattern is non-empty and non-trivial (≥ 8 chars)', () => {
			for (const p of PROMPT_INJECTION_PATTERNS) {
				assert.ok(p.length >= 8, `pattern too short: ${p}`);
			}
		});
	});

	suite('interleaveZeroWidth', () => {
		test('zero-length input → empty', () => {
			assert.strictEqual(interleaveZeroWidth(''), '');
		});

		test('inserts ZWSP between every character', () => {
			const r = interleaveZeroWidth('abc');
			assert.strictEqual(r, `a${ZERO_WIDTH_CHARS.zeroWidthSpace}b${ZERO_WIDTH_CHARS.zeroWidthSpace}c`);
		});

		test('custom char honored', () => {
			const r = interleaveZeroWidth('ab', BIDI_CHARS.rightToLeftOverride);
			assert.strictEqual(r, `a${BIDI_CHARS.rightToLeftOverride}b`);
		});

		test('result is flagged by findUnsafeInvisibleChars', () => {
			const r = interleaveZeroWidth('abc');
			assert.strictEqual(findUnsafeInvisibleChars(r).length, 2);
		});
	});

	suite('findUnsafeInvisibleChars', () => {
		test('clean string → empty', () => {
			assert.deepStrictEqual(findUnsafeInvisibleChars('hello world'), []);
		});

		test('embedded zero-width → flagged with codepoint string', () => {
			const r = findUnsafeInvisibleChars(`a${ZERO_WIDTH_CHARS.zeroWidthSpace}b`);
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].codepoint, 'U+200B');
		});

		test('multiple unsafe chars all reported', () => {
			const r = findUnsafeInvisibleChars(ZERO_WIDTH_BUNDLE);
			assert.ok(r.length >= 5);
		});

		test('codepoint formatted with U+ prefix and uppercase hex', () => {
			const r = findUnsafeInvisibleChars(BIDI_CHARS.rightToLeftOverride);
			assert.strictEqual(r[0].codepoint, 'U+202E');
		});
	});

	suite('findSecretCanaries', () => {
		test('clean string → empty', () => {
			assert.deepStrictEqual(findSecretCanaries('hello world'), []);
		});

		test('embedded canary → name returned', () => {
			const r = findSecretCanaries(`some log: ${SECRET_CANARIES.githubPat} oops`);
			assert.deepStrictEqual(r, ['githubPat']);
		});

		test('multiple canaries → all reported', () => {
			const r = findSecretCanaries(`${SECRET_CANARIES.githubPat}${SECRET_CANARIES.openaiKey}`);
			assert.deepStrictEqual([...r].sort(), ['githubPat', 'openaiKey']);
		});
	});
});
