// CJS mirror of src/vs/workbench/contrib/vibeide/common/snapshotIntegrityCheck.ts
// MUST stay in sync with the TS source.
'use strict';

// @ts-check

function parseSnapshotHeader(raw) {
	if (raw == null || typeof raw !== 'object') {
		return { ok: false, reason: 'not-an-object' };
	}
	const obj = /** @type {Record<string,unknown>} */ (raw);
	if (typeof obj.id !== 'string' || obj.id.length === 0) {
		return { ok: false, reason: 'id-missing' };
	}
	if (typeof obj.createdAt !== 'number' || !Number.isFinite(obj.createdAt) || obj.createdAt < 0) {
		return { ok: false, reason: 'createdAt-invalid' };
	}
	const bytesOnDisk = typeof obj.bytesOnDisk === 'number' && Number.isFinite(obj.bytesOnDisk) ? obj.bytesOnDisk : 0;
	return { ok: true, value: { id: obj.id, createdAt: obj.createdAt, bytesOnDisk } };
}

function checkSnapshotsIntegrity(entries) {
	const ok = [];
	const corrupt = [];
	for (const entry of entries) {
		const header = parseSnapshotHeader(entry.raw);
		if (!header.ok) {
			corrupt.push({ id: entry.id, reason: header.reason, rawSize: entry.rawSize });
			continue;
		}
		if (header.value.id !== entry.id) {
			corrupt.push({ id: entry.id, reason: `id-mismatch:filename=${entry.id},payload=${header.value.id}`, rawSize: entry.rawSize });
			continue;
		}
		ok.push(header.value);
	}
	return { ok, corrupt };
}

function renderCorruptSnapshotReport(corrupt) {
	if (corrupt.length === 0) return '';
	const lines = [];
	lines.push(`# Corrupt snapshot entries (${corrupt.length})`);
	lines.push('');
	for (const entry of corrupt) {
		const sizeNote = typeof entry.rawSize === 'number' ? ` (${entry.rawSize} bytes on disk)` : '';
		lines.push(`- \`${entry.id}\` — ${entry.reason}${sizeNote}`);
	}
	lines.push('');
	lines.push('_Other snapshots remain available; run `vibe doctor --repair --quarantine-snapshots` to move corrupt files to `.vibe/snapshots/.quarantine/`._');
	return lines.join('\n');
}

// Self-tests (node:assert, zero-dep).
if (require.main === module) {
	const assert = require('node:assert/strict');

	const good = { id: 'snap-1', createdAt: 1700000000000, bytesOnDisk: 1024 };
	const r1 = checkSnapshotsIntegrity([{ id: 'snap-1', raw: good }]);
	assert.equal(r1.ok.length, 1);
	assert.equal(r1.corrupt.length, 0);

	const r2 = checkSnapshotsIntegrity([{ id: 'snap-2', raw: null }]);
	assert.equal(r2.corrupt[0].reason, 'not-an-object');

	const r3 = checkSnapshotsIntegrity([{ id: 'snap-3', raw: { id: 'snap-99', createdAt: 0, bytesOnDisk: 0 } }]);
	assert.ok(r3.corrupt[0].reason.startsWith('id-mismatch'));

	const report = renderCorruptSnapshotReport(r2.corrupt);
	assert.ok(report.includes('snap-2'));

	console.log('snapshot-integrity-check.cjs: all self-tests passed');
}

module.exports = { checkSnapshotsIntegrity, parseSnapshotHeader, renderCorruptSnapshotReport };
