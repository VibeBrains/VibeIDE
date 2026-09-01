/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StringSHA1 } from '../../../../base/common/hash.js';

/**
 * Tamper-evidence for the audit log — pure helpers, no I/O.
 *
 * The journal is append-only by intent, but a plain JSONL file is append-only only by good manners:
 * a line can be cut out or rewritten and the result still parses. Each record therefore carries the
 * hash of the previous one, so removing or editing a line breaks the chain at a nameable place.
 *
 * What this does NOT claim: it is evidence of tampering, not prevention. Anyone who can rewrite the
 * file can rewrite the whole chain with it — the protection against that is the log living outside
 * the agent's file tools, not this. SHA-1 is enough for the job for the same reason: the goal is to
 * make an edit visible, not to withstand a resourceful forger.
 */

/** Field name of the previous record's hash. Short, because it repeats on every line. */
export const AUDIT_CHAIN_FIELD = 'prev';

/** Hash of the first record's predecessor — a fixed root, so line 1 is chained like the rest. */
export const AUDIT_CHAIN_ROOT = 'root';

/** Hash of one serialized record. The line is hashed verbatim: what is on disk is what is signed. */
export function auditLineHash(line: string): string {
	const sha = new StringSHA1();
	sha.update(line);
	return sha.digest();
}

/** Attach the chain field to a record. Returns the serialized line and its own hash. */
export function chainRecord(record: object, previousHash: string): { line: string; hash: string } {
	const line = JSON.stringify({ ...record, [AUDIT_CHAIN_FIELD]: previousHash });
	return { line, hash: auditLineHash(line) };
}

export type AuditChainVerdict =
	| { readonly ok: true; readonly checked: number }
	/** `line` is 1-based — it is meant to be read by a human looking at the file. */
	| { readonly ok: false; readonly line: number; readonly reason: 'broken-link' | 'unparsable' | 'unchained' };

/**
 * Walk the file and report the first place the chain stops adding up.
 *
 * Records written before chaining existed have no `prev` field. They are reported as `unchained`
 * rather than skipped: silence would let someone strip the field from a record to erase its link,
 * and «no chain here» would look exactly like «old file».
 */
export function verifyAuditChain(lines: readonly string[]): AuditChainVerdict {
	let expected = AUDIT_CHAIN_ROOT;
	let checked = 0;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (raw.trim() === '') { continue; }
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return { ok: false, line: i + 1, reason: 'unparsable' };
		}
		const prev = parsed[AUDIT_CHAIN_FIELD];
		if (typeof prev !== 'string') {
			return { ok: false, line: i + 1, reason: 'unchained' };
		}
		if (prev !== expected) {
			return { ok: false, line: i + 1, reason: 'broken-link' };
		}
		expected = auditLineHash(raw);
		checked++;
	}
	return { ok: true, checked };
}

/** Hash to continue an existing file from — the last record's, or the root for an empty one. */
export function chainTailOf(lines: readonly string[]): string {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() !== '') { return auditLineHash(lines[i]); }
	}
	return AUDIT_CHAIN_ROOT;
}

/**
 * Serialized size of a batch, without committing to the hashes it would produce.
 *
 * Rotation is decided before chaining (a batch chained to the old tail must never land in the fresh
 * file), so the size has to be known one step earlier. The chain field has a fixed width, which is
 * what makes the estimate exact rather than approximate.
 */
export function estimateChainedSize(records: readonly object[], previousHash: string): number {
	let tail = previousHash;
	let bytes = 0;
	for (const record of records) {
		const { line, hash } = chainRecord(record, tail);
		tail = hash;
		bytes += line.length + 1; // + newline
	}
	return bytes;
}
