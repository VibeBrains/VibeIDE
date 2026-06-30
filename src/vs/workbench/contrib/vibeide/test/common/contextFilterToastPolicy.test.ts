/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideContextFilterToast,
	describeContextFilterToast,
} from '../../common/contextFilterToastPolicy.js';

suite('contextFilterToastPolicy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideContextFilterToast', () => {
		test('mode raw → never emits', () => {
			const r = decideContextFilterToast({ mode: 'raw', ctxPct: 0.99, hasShownToastThisSession: false });
			assert.strictEqual(r.emit, false);
			assert.strictEqual(r.reason, 'mode-not-auto');
		});

		test('mode aggregate → never emits (user explicit choice)', () => {
			const r = decideContextFilterToast({ mode: 'aggregate', ctxPct: 0.99, hasShownToastThisSession: false });
			assert.strictEqual(r.emit, false);
			assert.strictEqual(r.reason, 'mode-not-auto');
		});

		test('mode off → never emits', () => {
			const r = decideContextFilterToast({ mode: 'off', ctxPct: 0.99, hasShownToastThisSession: false });
			assert.strictEqual(r.emit, false);
		});

		test('auto + already shown this session → no emit', () => {
			const r = decideContextFilterToast({ mode: 'auto', ctxPct: 0.85, hasShownToastThisSession: true });
			assert.strictEqual(r.emit, false);
			assert.strictEqual(r.reason, 'already-shown');
		});

		test('auto + below threshold → no emit', () => {
			const r = decideContextFilterToast({ mode: 'auto', ctxPct: 0.50, hasShownToastThisSession: false });
			assert.strictEqual(r.emit, false);
			assert.strictEqual(r.reason, 'below-threshold');
		});

		test('auto + at threshold → emit (boundary inclusive)', () => {
			const r = decideContextFilterToast({ mode: 'auto', ctxPct: 0.70, hasShownToastThisSession: false });
			assert.strictEqual(r.emit, true);
			assert.strictEqual(r.reason, 'first-auto-trigger');
		});

		test('auto + above threshold → emit', () => {
			const r = decideContextFilterToast({ mode: 'auto', ctxPct: 0.85, hasShownToastThisSession: false });
			assert.strictEqual(r.emit, true);
		});

		test('custom threshold honored', () => {
			const r = decideContextFilterToast({ mode: 'auto', ctxPct: 0.55, hasShownToastThisSession: false, threshold: 0.50 });
			assert.strictEqual(r.emit, true);
		});

		test('threshold returned in decision regardless of emit', () => {
			const a = decideContextFilterToast({ mode: 'raw', ctxPct: 0.99, hasShownToastThisSession: false });
			assert.strictEqual(a.thresholdPct, 0.70);
			const b = decideContextFilterToast({ mode: 'auto', ctxPct: 0.50, hasShownToastThisSession: false, threshold: 0.85 });
			assert.strictEqual(b.thresholdPct, 0.85);
		});

		test('clamp: ctxPct > 1 treated as 1.0 → emit', () => {
			const r = decideContextFilterToast({ mode: 'auto', ctxPct: 1.5, hasShownToastThisSession: false });
			assert.strictEqual(r.emit, true);
		});

		test('clamp: ctxPct < 0 treated as 0 → no emit', () => {
			const r = decideContextFilterToast({ mode: 'auto', ctxPct: -0.5, hasShownToastThisSession: false });
			assert.strictEqual(r.emit, false);
			assert.strictEqual(r.reason, 'below-threshold');
		});

		test('clamp: NaN treated as 0 → no emit', () => {
			const r = decideContextFilterToast({ mode: 'auto', ctxPct: NaN, hasShownToastThisSession: false });
			assert.strictEqual(r.emit, false);
		});

		test('clamp: threshold > 1 → effective 1.0 (so ctxPct never reaches it without clamp)', () => {
			const r = decideContextFilterToast({ mode: 'auto', ctxPct: 0.99, hasShownToastThisSession: false, threshold: 1.5 });
			assert.strictEqual(r.thresholdPct, 1.0);
			// 0.99 < 1.0 → no emit
			assert.strictEqual(r.emit, false);
		});
	});

	suite('describeContextFilterToast', () => {
		test('renders Russian text with rounded percent', () => {
			assert.strictEqual(describeContextFilterToast(0.70), 'VibeIDE: контекст ≥ 70% — включена авто-агрегация инструментов. Можно открыть полный сырой лог или сменить режим в настройках.');
		});

		test('rounds 0.85 to 85%', () => {
			assert.match(describeContextFilterToast(0.85), /85%/);
		});

		test('rounds 0.706 to 71% (banker rounding default JS)', () => {
			assert.match(describeContextFilterToast(0.706), /71%/);
		});

		test('mentions "сырой лог" so user can search', () => {
			assert.match(describeContextFilterToast(0.70), /сырой лог/);
		});
	});
});
