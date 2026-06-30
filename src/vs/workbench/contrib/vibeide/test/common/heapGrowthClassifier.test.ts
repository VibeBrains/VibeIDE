/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	classifyHeapGrowth,
	decodeHeapSnapshot,
	renderHeapGrowthMarkdown,
	HeapSnapshot,
} from '../../common/heapGrowthClassifier.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const MIB = 1_048_576;

const snap = (overrides: Partial<HeapSnapshot> = {}): HeapSnapshot => ({
	capturedAtMs: 0,
	heapUsedBytes: 100 * MIB,
	heapTotalBytes: 200 * MIB,
	...overrides,
});

suite('heapGrowthClassifier', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('classifyHeapGrowth', () => {
		test('elapsed < 60s → inconclusive', () => {
			const r = classifyHeapGrowth(
				snap({ capturedAtMs: 0 }),
				snap({ capturedAtMs: 30_000 }),
			);
			assert.strictEqual(r.classification, 'inconclusive');
		});

		test('flat: small delta and small percent', () => {
			const r = classifyHeapGrowth(
				snap({ capturedAtMs: 0, heapUsedBytes: 100 * MIB }),
				snap({ capturedAtMs: 90_000, heapUsedBytes: 100 * MIB + 100_000 }),
			);
			assert.strictEqual(r.classification, 'flat');
		});

		test('shrinking: significant negative delta', () => {
			const r = classifyHeapGrowth(
				snap({ capturedAtMs: 0, heapUsedBytes: 200 * MIB }),
				snap({ capturedAtMs: 90_000, heapUsedBytes: 150 * MIB }),
			);
			assert.strictEqual(r.classification, 'shrinking');
		});

		test('growing-normal: 5% growth', () => {
			const r = classifyHeapGrowth(
				snap({ capturedAtMs: 0, heapUsedBytes: 100 * MIB }),
				snap({ capturedAtMs: 90_000, heapUsedBytes: 105 * MIB }),
			);
			assert.strictEqual(r.classification, 'growing-normal');
		});

		test('leak-suspicious: 25% growth + 50+ MB', () => {
			const r = classifyHeapGrowth(
				snap({ capturedAtMs: 0, heapUsedBytes: 200 * MIB }),
				snap({ capturedAtMs: 90_000, heapUsedBytes: 260 * MIB }),
			);
			assert.strictEqual(r.classification, 'leak-suspicious');
		});

		test('large pct but small bytes (small base) → growing-normal not leak', () => {
			// 10MB → 13MB = 30% but only 3MB delta < 50MB leak threshold
			const r = classifyHeapGrowth(
				snap({ capturedAtMs: 0, heapUsedBytes: 10 * MIB }),
				snap({ capturedAtMs: 90_000, heapUsedBytes: 13 * MIB }),
			);
			assert.strictEqual(r.classification, 'growing-normal');
		});

		test('large bytes but small pct (huge base) → growing-normal not leak', () => {
			// 5GB → 5.06GB = 1.2% but 60MB delta > 50MB. Not leak (pct gate).
			const r = classifyHeapGrowth(
				snap({ capturedAtMs: 0, heapUsedBytes: 5_000 * MIB }),
				snap({ capturedAtMs: 90_000, heapUsedBytes: 5_060 * MIB }),
			);
			assert.strictEqual(r.classification, 'growing-normal');
		});

		test('zero baseline heapUsedBytes → deltaUsedPct stays 0 (no NaN)', () => {
			const r = classifyHeapGrowth(
				snap({ capturedAtMs: 0, heapUsedBytes: 0 }),
				snap({ capturedAtMs: 90_000, heapUsedBytes: 100 * MIB }),
			);
			assert.strictEqual(r.deltaUsedPct, 0);
			assert.ok(Number.isFinite(r.deltaUsedPct));
		});

		test('custom thresholds honored', () => {
			// Tighter leak threshold catches what default would miss
			const r = classifyHeapGrowth(
				snap({ capturedAtMs: 0, heapUsedBytes: 100 * MIB }),
				snap({ capturedAtMs: 90_000, heapUsedBytes: 110 * MIB }),
				{ leakPctThreshold: 0.05, leakBytesThreshold: 5 * MIB },
			);
			assert.strictEqual(r.classification, 'leak-suspicious');
		});

		test('reason field is non-empty in every branch', () => {
			const inputs = [
				{ baseline: snap({ capturedAtMs: 0 }), current: snap({ capturedAtMs: 1_000 }) }, // inconclusive
				{ baseline: snap({ capturedAtMs: 0, heapUsedBytes: 100 * MIB }), current: snap({ capturedAtMs: 90_000, heapUsedBytes: 100 * MIB }) }, // flat
				{ baseline: snap({ capturedAtMs: 0, heapUsedBytes: 200 * MIB }), current: snap({ capturedAtMs: 90_000, heapUsedBytes: 150 * MIB }) }, // shrinking
				{ baseline: snap({ capturedAtMs: 0, heapUsedBytes: 100 * MIB }), current: snap({ capturedAtMs: 90_000, heapUsedBytes: 105 * MIB }) }, // growing-normal
				{ baseline: snap({ capturedAtMs: 0, heapUsedBytes: 200 * MIB }), current: snap({ capturedAtMs: 90_000, heapUsedBytes: 260 * MIB }) }, // leak
			];
			for (const { baseline, current } of inputs) {
				const r = classifyHeapGrowth(baseline, current);
				assert.ok(r.reason.length > 0, `empty reason for classification ${r.classification}`);
			}
		});

		test('deltaUsedPct rounded to 1 decimal precision', () => {
			const r = classifyHeapGrowth(
				snap({ capturedAtMs: 0, heapUsedBytes: 100 * MIB }),
				snap({ capturedAtMs: 90_000, heapUsedBytes: 105 * MIB }),
			);
			// 5/100 = 0.05; with rounding to 3 decimals this stays 0.05
			assert.ok(Math.abs(r.deltaUsedPct - 0.05) < 0.001);
		});

		test('labels carried through into diff output', () => {
			const r = classifyHeapGrowth(
				snap({ capturedAtMs: 0, label: 'before-test' }),
				snap({ capturedAtMs: 90_000, label: 'after-test' }),
			);
			assert.strictEqual(r.baselineLabel, 'before-test');
			assert.strictEqual(r.currentLabel, 'after-test');
		});
	});

	suite('decodeHeapSnapshot', () => {
		test('valid object → typed snapshot', () => {
			const r = decodeHeapSnapshot({ capturedAtMs: 1, heapUsedBytes: 100, heapTotalBytes: 200 });
			assert.ok(r);
			assert.strictEqual(r!.heapUsedBytes, 100);
		});

		test('with optional fields', () => {
			const r = decodeHeapSnapshot({
				capturedAtMs: 1,
				heapUsedBytes: 100,
				heapTotalBytes: 200,
				externalBytes: 50,
				arrayBuffersBytes: 25,
				label: 'baseline',
			});
			assert.strictEqual(r?.externalBytes, 50);
			assert.strictEqual(r?.arrayBuffersBytes, 25);
			assert.strictEqual(r?.label, 'baseline');
		});

		test('null/non-object → null', () => {
			assert.strictEqual(decodeHeapSnapshot(null), null);
			assert.strictEqual(decodeHeapSnapshot('string'), null);
			assert.strictEqual(decodeHeapSnapshot(42), null);
		});

		test('missing required field → null', () => {
			assert.strictEqual(decodeHeapSnapshot({ heapUsedBytes: 100, heapTotalBytes: 200 }), null);
		});

		test('NaN field → null', () => {
			assert.strictEqual(decodeHeapSnapshot({ capturedAtMs: NaN, heapUsedBytes: 1, heapTotalBytes: 2 }), null);
		});

		test('negative bytes rejected', () => {
			assert.strictEqual(decodeHeapSnapshot({ capturedAtMs: 1, heapUsedBytes: -1, heapTotalBytes: 2 }), null);
		});

		test('empty label dropped', () => {
			const r = decodeHeapSnapshot({ capturedAtMs: 1, heapUsedBytes: 100, heapTotalBytes: 200, label: '' });
			assert.strictEqual(r?.label, undefined);
		});
	});

	suite('renderHeapGrowthMarkdown', () => {
		test('includes classification tag', () => {
			const diff = classifyHeapGrowth(
				snap({ capturedAtMs: 0, heapUsedBytes: 200 * MIB }),
				snap({ capturedAtMs: 90_000, heapUsedBytes: 260 * MIB }),
			);
			const md = renderHeapGrowthMarkdown(diff);
			assert.match(md, /\*\*leak-suspicious\*\*/);
		});

		test('shows duration in s/m/h', () => {
			const diff = classifyHeapGrowth(
				snap({ capturedAtMs: 0, heapUsedBytes: 100 * MIB }),
				snap({ capturedAtMs: 5 * 60_000, heapUsedBytes: 105 * MIB }),
			);
			assert.match(renderHeapGrowthMarkdown(diff), /elapsed: 5m/);
		});

		test('shows labels when present', () => {
			const diff = classifyHeapGrowth(
				snap({ capturedAtMs: 0, label: 'A' }),
				snap({ capturedAtMs: 90_000, label: 'B' }),
			);
			assert.match(renderHeapGrowthMarkdown(diff), /A.*B/);
		});

		test('handles missing labels gracefully', () => {
			const diff = classifyHeapGrowth(snap({ capturedAtMs: 0 }), snap({ capturedAtMs: 90_000 }));
			const md = renderHeapGrowthMarkdown(diff);
			assert.ok(md.length > 0);
			assert.ok(!md.includes('undefined'));
		});
	});
});
