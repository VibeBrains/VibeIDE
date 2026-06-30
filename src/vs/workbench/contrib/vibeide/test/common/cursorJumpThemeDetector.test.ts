/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	detectCursorJumpTheme,
	trimEditLog,
	EditEvent,
	THEME_DEFAULTS,
} from '../../common/cursorJumpThemeDetector.js';

const NOW = 1_000_000;
const RENAME = (ts: number, from: string, to: string, file: string = 'a.ts'): EditEvent => ({
	timestamp: ts, fileUri: file, kind: 'rename', subject: from, subjectReplacement: to,
});
const SIG = (ts: number, fn: string, file: string = 'a.ts'): EditEvent => ({
	timestamp: ts, fileUri: file, kind: 'signature-change', subject: fn,
});
const OTHER = (ts: number): EditEvent => ({
	timestamp: ts, fileUri: 'a.ts', kind: 'other',
});

suite('Cursor-jump theme detector (1029)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('detectCursorJumpTheme', () => {
		test('empty log → no-theme', () => {
			assert.deepStrictEqual(detectCursorJumpTheme([]), { kind: 'no-theme' });
		});

		test('only "other" events → no-theme', () => {
			assert.deepStrictEqual(
				detectCursorJumpTheme([OTHER(1), OTHER(2), OTHER(3)]),
				{ kind: 'no-theme' },
			);
		});

		test('3 consecutive renames of same identifier → theme-detected', () => {
			const r = detectCursorJumpTheme([
				RENAME(NOW, 'foo', 'bar'),
				RENAME(NOW + 1000, 'foo', 'bar'),
				RENAME(NOW + 2000, 'foo', 'bar'),
			]);
			assert.strictEqual(r.kind, 'theme-detected');
			if (r.kind === 'theme-detected') {
				assert.strictEqual(r.theme, 'rename');
				assert.strictEqual(r.subject, 'foo');
				assert.strictEqual(r.subjectReplacement, 'bar');
				assert.strictEqual(r.eventCount, 3);
			}
		});

		test('2 renames is not enough for default threshold of 3', () => {
			const r = detectCursorJumpTheme([
				RENAME(NOW, 'foo', 'bar'),
				RENAME(NOW + 1000, 'foo', 'bar'),
			]);
			assert.deepStrictEqual(r, { kind: 'no-theme' });
		});

		test('"other" events do not break the streak', () => {
			const r = detectCursorJumpTheme([
				RENAME(NOW, 'foo', 'bar'),
				OTHER(NOW + 500),
				RENAME(NOW + 1000, 'foo', 'bar'),
				OTHER(NOW + 1500),
				RENAME(NOW + 2000, 'foo', 'bar'),
			]);
			assert.strictEqual(r.kind, 'theme-detected');
		});

		test('different subject breaks the streak', () => {
			const r = detectCursorJumpTheme([
				RENAME(NOW, 'baz', 'qux'),  // outside streak
				RENAME(NOW + 500, 'foo', 'bar'),
				RENAME(NOW + 1000, 'foo', 'bar'),
				RENAME(NOW + 2000, 'foo', 'bar'),
			]);
			// 3 'foo→bar' renames → still detected, the 'baz→qux' is outside the streak.
			assert.strictEqual(r.kind, 'theme-detected');
			if (r.kind === 'theme-detected') { assert.strictEqual(r.eventCount, 3); }
		});

		test('mixed kinds break the streak', () => {
			const r = detectCursorJumpTheme([
				RENAME(NOW, 'foo', 'bar'),
				RENAME(NOW + 1000, 'foo', 'bar'),
				SIG(NOW + 2000, 'foo'),
			]);
			// Last event is signature-change; only 1 of that kind.
			assert.deepStrictEqual(r, { kind: 'no-theme' });
		});

		test('signature-change theme detected with 3 events', () => {
			const r = detectCursorJumpTheme([
				SIG(NOW, 'doSomething'),
				SIG(NOW + 1000, 'doSomething'),
				SIG(NOW + 2000, 'doSomething'),
			]);
			assert.strictEqual(r.kind, 'theme-detected');
			if (r.kind === 'theme-detected') {
				assert.strictEqual(r.theme, 'signature-change');
				assert.strictEqual(r.subject, 'doSomething');
			}
		});

		test('large time gap breaks the streak', () => {
			const r = detectCursorJumpTheme([
				RENAME(NOW, 'foo', 'bar'),
				RENAME(NOW + 1000, 'foo', 'bar'),
				// gap from the 2nd event (at NOW+1000) must exceed maxGapMs to break the streak.
				RENAME(NOW + 1000 + THEME_DEFAULTS.maxGapMs + 1, 'foo', 'bar'),
			], THEME_DEFAULTS);
			// gap between 2nd and 3rd > maxGapMs → only 1 in the streak.
			assert.deepStrictEqual(r, { kind: 'no-theme' });
		});

		test('respects custom threshold', () => {
			const r = detectCursorJumpTheme([
				RENAME(NOW, 'foo', 'bar'),
				RENAME(NOW + 1000, 'foo', 'bar'),
			], { ...THEME_DEFAULTS, consecutiveThreshold: 2 });
			assert.strictEqual(r.kind, 'theme-detected');
		});
	});

	suite('trimEditLog', () => {
		test('drops events older than the keep window', () => {
			const events = [
				RENAME(NOW - 30 * 60 * 1000, 'a', 'b'),
				RENAME(NOW - 1000, 'a', 'b'),
				RENAME(NOW, 'a', 'b'),
			];
			// Default keep window = maxGapMs * 4 = 20 minutes
			const trimmed = trimEditLog(events, NOW);
			assert.strictEqual(trimmed.length, 2);
		});

		test('all-recent events survive', () => {
			const events = [RENAME(NOW - 1000, 'a', 'b'), RENAME(NOW, 'a', 'b')];
			assert.strictEqual(trimEditLog(events, NOW).length, 2);
		});

		test('custom window', () => {
			const events = [RENAME(NOW - 5000, 'a', 'b'), RENAME(NOW, 'a', 'b')];
			assert.strictEqual(trimEditLog(events, NOW, 1000).length, 1);
		});
	});
});
