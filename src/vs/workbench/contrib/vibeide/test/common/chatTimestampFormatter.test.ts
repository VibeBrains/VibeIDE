/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	formatChatTimestamp,
	chatTimestampToISO,
	CHAT_TIMESTAMP_STREAMING_PLACEHOLDER,
} from '../../common/chatTimestampFormatter.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Chat timestamp formatter — pure helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('formatChatTimestamp', () => {
		// Pick a fixed unix-ms value: 2026-05-08T14:32:07 — values are local-time
		// dependent, so we assert via round-trip: format with explicit tokens and
		// verify each piece against `Date` directly (avoids TZ flakiness on CI).
		test('default pattern matches DD.MM.YYYY HH:mm', () => {
			const ts = Date.now();
			const out = formatChatTimestamp(ts);
			assert.match(out, /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);
		});

		test('custom pattern with seconds', () => {
			const ts = Date.now();
			const out = formatChatTimestamp(ts, 'YYYY-MM-DD HH:mm:ss');
			assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		});

		test('zero-pads single-digit month and day (Jan 5)', () => {
			const d = new Date(2026, 0, 5, 9, 3, 7); // local time
			const out = formatChatTimestamp(d.getTime(), 'YYYY-MM-DD HH:mm:ss');
			assert.strictEqual(out, '2026-01-05 09:03:07');
		});

		test('end-of-year boundary (Dec 31 23:59)', () => {
			const d = new Date(2025, 11, 31, 23, 59, 59);
			const out = formatChatTimestamp(d.getTime(), 'YYYY-MM-DD HH:mm:ss');
			assert.strictEqual(out, '2025-12-31 23:59:59');
		});

		test('leap-year Feb 29', () => {
			const d = new Date(2024, 1, 29, 12, 0, 0);
			const out = formatChatTimestamp(d.getTime(), 'YYYY-MM-DD');
			assert.strictEqual(out, '2024-02-29');
		});

		test('preserves literal characters in pattern', () => {
			const d = new Date(2026, 4, 8, 14, 32, 0);
			const out = formatChatTimestamp(d.getTime(), '[YYYY.MM.DD HH:mm]');
			assert.strictEqual(out, '[2026.05.08 14:32]');
		});

		test('non-finite input returns empty string', () => {
			assert.strictEqual(formatChatTimestamp(NaN), '');
			assert.strictEqual(formatChatTimestamp(Infinity), '');
			assert.strictEqual(formatChatTimestamp(-Infinity), '');
		});

		test('non-number input returns empty string', () => {
			assert.strictEqual(formatChatTimestamp(undefined), '');
			assert.strictEqual(formatChatTimestamp(null), '');
			assert.strictEqual(formatChatTimestamp('1234567890000'), '');
			assert.strictEqual(formatChatTimestamp({}), '');
		});

		test('unknown tokens pass through verbatim', () => {
			const d = new Date(2026, 4, 8, 14, 32, 0);
			const out = formatChatTimestamp(d.getTime(), 'YYYY-foo-MM');
			assert.strictEqual(out, '2026-foo-05');
		});

		test('millisecond boundary preserves second', () => {
			const d = new Date(2026, 4, 8, 14, 32, 7, 999);
			const out = formatChatTimestamp(d.getTime(), 'ss');
			assert.strictEqual(out, '07');
		});
	});

	suite('chatTimestampToISO', () => {
		test('valid timestamp returns ISO-8601 string', () => {
			const ts = Date.UTC(2026, 4, 8, 14, 32, 7);
			assert.strictEqual(chatTimestampToISO(ts), '2026-05-08T14:32:07.000Z');
		});

		test('non-finite input returns empty string', () => {
			assert.strictEqual(chatTimestampToISO(NaN), '');
			assert.strictEqual(chatTimestampToISO(Infinity), '');
		});

		test('non-number input returns empty string', () => {
			assert.strictEqual(chatTimestampToISO(undefined), '');
			assert.strictEqual(chatTimestampToISO('foo'), '');
		});
	});

	suite('CHAT_TIMESTAMP_STREAMING_PLACEHOLDER', () => {
		test('matches the visual width of DD.MM.YYYY HH:mm', () => {
			const real = formatChatTimestamp(Date.UTC(2026, 4, 8, 14, 32, 0));
			assert.strictEqual(real.length, CHAT_TIMESTAMP_STREAMING_PLACEHOLDER.length);
		});

		test('contains no digits', () => {
			assert.ok(!/\d/.test(CHAT_TIMESTAMP_STREAMING_PLACEHOLDER));
		});
	});
});
