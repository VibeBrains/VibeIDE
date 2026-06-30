/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Snapshot integrity check (1037) — pure helper.
 *
 * `.vibe/snapshots/<id>.json` files can corrupt mid-write (power loss,
 * disk full, IDE crash). Today a single corrupt entry breaks the entire
 * snapshot list because the loader bails on the first parse error. This
 * module isolates corrupt entries so the rest of the list remains usable
 * and `vibe doctor` can report the bad ones.
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface SnapshotEntryHeader {
	id: string;
	createdAt: number;
	bytesOnDisk: number;
}

export interface IntegrityResult {
	ok: SnapshotEntryHeader[];
	corrupt: ReadonlyArray<{ id: string; reason: string; rawSize?: number }>;
}

export type RawSnapshotInput = { id: string; raw: unknown; rawSize?: number };

/**
 * Inspect a list of raw snapshot entries (one per file). Returns the
 * partition into `ok` (usable) and `corrupt` (skip with reason). Pure —
 * does not touch the FS.
 */
export function checkSnapshotsIntegrity(entries: ReadonlyArray<RawSnapshotInput>): IntegrityResult {
	const ok: SnapshotEntryHeader[] = [];
	const corrupt: { id: string; reason: string; rawSize?: number }[] = [];
	for (const entry of entries) {
		const header = parseSnapshotHeader(entry.raw);
		if (!header.ok) {
			corrupt.push({ id: entry.id, reason: header.reason, rawSize: entry.rawSize });
			continue;
		}
		// Cross-check: the id from the file content should match the file id
		// the caller passed in (filename). Mismatch indicates rename/copy.
		if (header.value.id !== entry.id) {
			corrupt.push({
				id: entry.id,
				reason: `id-mismatch:filename=${entry.id},payload=${header.value.id}`,
				rawSize: entry.rawSize,
			});
			continue;
		}
		ok.push(header.value);
	}
	return { ok, corrupt };
}

/**
 * Parse a single snapshot header. Returns a tagged result; the wrapper
 * decides whether to log or suppress the parse error.
 */
export function parseSnapshotHeader(raw: unknown): { ok: true; value: SnapshotEntryHeader } | { ok: false; reason: string } {
	if (raw === null || raw === undefined || typeof raw !== 'object') {
		return { ok: false, reason: 'not-an-object' };
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.id !== 'string' || obj.id.length === 0) {
		return { ok: false, reason: 'id-missing' };
	}
	if (typeof obj.createdAt !== 'number' || !Number.isFinite(obj.createdAt) || obj.createdAt < 0) {
		return { ok: false, reason: 'createdAt-invalid' };
	}
	const bytesOnDisk = typeof obj.bytesOnDisk === 'number' && Number.isFinite(obj.bytesOnDisk) ? obj.bytesOnDisk : 0;
	return { ok: true, value: { id: obj.id, createdAt: obj.createdAt, bytesOnDisk } };
}

/**
 * Build the message `vibe doctor` should show for a corrupt set. Pure —
 * caller writes the report, no IO here. Returns empty string when the
 * input list is empty.
 */
export function renderCorruptSnapshotReport(corrupt: ReadonlyArray<{ id: string; reason: string; rawSize?: number }>): string {
	if (corrupt.length === 0) { return ''; }
	const lines: string[] = [];
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
