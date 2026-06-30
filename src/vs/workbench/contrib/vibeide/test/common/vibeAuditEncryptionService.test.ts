/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	RECOVERY_PHRASE_WORD_LIST,
	RECOVERY_PHRASE_WORDS,
	RECOVERY_PHRASE_MIN_WORDS,
	generateRecoveryPhraseFrom,
	validateRecoveryPhrase,
} from '../../common/vibeAuditEncryptionService.js';

suite('VibeAuditEncryptionService — pure helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('generateRecoveryPhraseFrom', () => {
		test('produces exactly RECOVERY_PHRASE_WORDS words', () => {
			const phrase = generateRecoveryPhraseFrom();
			const words = phrase.split(' ');
			assert.strictEqual(words.length, RECOVERY_PHRASE_WORDS);
		});

		test('every word comes from the configured word list', () => {
			const phrase = generateRecoveryPhraseFrom();
			const setOf = new Set(RECOVERY_PHRASE_WORD_LIST);
			for (const w of phrase.split(' ')) {
				assert.ok(setOf.has(w), `word '${w}' is not in RECOVERY_PHRASE_WORD_LIST`);
			}
		});

		test('deterministic with a seeded RNG', () => {
			let seed = 0;
			const rng = () => {
				seed = (seed * 9301 + 49297) % 233280;
				return seed / 233280;
			};
			const a = generateRecoveryPhraseFrom(undefined, rng);
			seed = 0;
			const b = generateRecoveryPhraseFrom(undefined, rng);
			assert.strictEqual(a, b);
		});

		test('respects custom word list', () => {
			const list = ['alpha', 'beta', 'gamma'];
			const phrase = generateRecoveryPhraseFrom(list, () => 0); // always picks index 0
			const words = phrase.split(' ');
			for (const w of words) {
				assert.strictEqual(w, 'alpha');
			}
		});
	});

	suite('validateRecoveryPhrase', () => {
		test('null / undefined / empty rejected', () => {
			assert.ok(validateRecoveryPhrase(null));
			assert.ok(validateRecoveryPhrase(undefined));
			assert.ok(validateRecoveryPhrase(''));
		});

		test('phrase shorter than minimum rejected', () => {
			const tooShort = Array(RECOVERY_PHRASE_MIN_WORDS - 1).fill('apple').join(' ');
			assert.ok(validateRecoveryPhrase(tooShort));
		});

		test('phrase at minimum length accepted', () => {
			const ok = Array(RECOVERY_PHRASE_MIN_WORDS).fill('apple').join(' ');
			assert.strictEqual(validateRecoveryPhrase(ok), null);
		});

		test('full 24-word phrase accepted', () => {
			const ok = Array(RECOVERY_PHRASE_WORDS).fill('apple').join(' ');
			assert.strictEqual(validateRecoveryPhrase(ok), null);
		});

		test('phrase with extra whitespace counts non-empty words only', () => {
			const ok = Array(RECOVERY_PHRASE_MIN_WORDS).fill('apple').join('  '); // double-space
			assert.strictEqual(validateRecoveryPhrase(ok), null);
		});
	});
});
