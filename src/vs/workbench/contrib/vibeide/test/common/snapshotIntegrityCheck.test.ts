/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	checkSnapshotsIntegrity,
	parseSnapshotHeader,
	renderCorruptSnapshotReport,
} from '../../common/snapshotIntegrityCheck.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const valid = (id: string, ts: number = 1, size: number = 100) => ({ id, createdAt: ts, bytesOnDisk: size });

suite('Snapshot integrity check (1037)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseSnapshotHeader', () => {
		test('valid object passes', () => {
			const r = parseSnapshotHeader(valid('s1', 1234, 500));
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.id, 's1'); }
		});

		test('rejects null / non-object', () => {
			assert.deepStrictEqual(parseSnapshotHeader(null), { ok: false, reason: 'not-an-object' });
			assert.deepStrictEqual(parseSnapshotHeader('str'), { ok: false, reason: 'not-an-object' });
		});

		test('rejects empty id', () => {
			assert.deepStrictEqual(parseSnapshotHeader({ id: '', createdAt: 1 }), { ok: false, reason: 'id-missing' });
		});

		test('rejects non-finite createdAt', () => {
			assert.deepStrictEqual(parseSnapshotHeader({ id: 's', createdAt: NaN }), { ok: false, reason: 'createdAt-invalid' });
			assert.deepStrictEqual(parseSnapshotHeader({ id: 's', createdAt: -1 }), { ok: false, reason: 'createdAt-invalid' });
		});

		test('bytesOnDisk defaults to 0 when missing', () => {
			const r = parseSnapshotHeader({ id: 's', createdAt: 1 });
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.bytesOnDisk, 0); }
		});
	});

	suite('checkSnapshotsIntegrity', () => {
		test('all-ok partition', () => {
			const r = checkSnapshotsIntegrity([
				{ id: 's1', raw: valid('s1') },
				{ id: 's2', raw: valid('s2') },
			]);
			assert.strictEqual(r.ok.length, 2);
			assert.strictEqual(r.corrupt.length, 0);
		});

		test('isolates corrupt entries; rest survives', () => {
			const r = checkSnapshotsIntegrity([
				{ id: 's1', raw: valid('s1') },
				{ id: 's2', raw: { id: 's2' /* missing createdAt */ } },
				{ id: 's3', raw: valid('s3') },
				{ id: 's4', raw: null, rawSize: 0 },
			]);
			assert.deepStrictEqual(r.ok.map(e => e.id), ['s1', 's3']);
			assert.strictEqual(r.corrupt.length, 2);
			assert.strictEqual(r.corrupt[0].id, 's2');
			assert.strictEqual(r.corrupt[0].reason, 'createdAt-invalid');
			assert.strictEqual(r.corrupt[1].id, 's4');
			assert.strictEqual(r.corrupt[1].reason, 'not-an-object');
			assert.strictEqual(r.corrupt[1].rawSize, 0);
		});

		test('flags id-mismatch (filename vs payload)', () => {
			const r = checkSnapshotsIntegrity([
				{ id: 's1', raw: valid('different-id') },
			]);
			assert.strictEqual(r.ok.length, 0);
			assert.match(r.corrupt[0].reason, /^id-mismatch:filename=s1,payload=different-id$/);
		});

		test('empty input → empty buckets', () => {
			assert.deepStrictEqual(checkSnapshotsIntegrity([]), { ok: [], corrupt: [] });
		});
	});

	suite('renderCorruptSnapshotReport', () => {
		test('empty list renders empty string', () => {
			assert.strictEqual(renderCorruptSnapshotReport([]), '');
		});

		test('renders header + entry per corrupt with size', () => {
			const md = renderCorruptSnapshotReport([
				{ id: 's1', reason: 'not-an-object', rawSize: 0 },
				{ id: 's2', reason: 'createdAt-invalid' },
			]);
			assert.ok(md.includes('# Corrupt snapshot entries (2)'));
			assert.ok(md.includes('`s1` — not-an-object (0 bytes on disk)'));
			assert.ok(md.includes('`s2` — createdAt-invalid'));
			assert.ok(md.includes('vibe doctor --repair --quarantine-snapshots'));
		});
	});
});
