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
	| {
		readonly ok: true;
		readonly checked: number;
		/**
		 * Records written before chaining existed, sitting as an unbroken run at the head of the
		 * file. Reported rather than hidden: «checked 3 of 5» is a different statement from
		 * «checked 5», and the person reading the verdict is entitled to the difference.
		 */
		readonly legacyPrefix?: number;
	}
	/** `line` is 1-based — it is meant to be read by a human looking at the file. */
	| { readonly ok: false; readonly line: number; readonly reason: 'broken-link' | 'unparsable' | 'unchained' };

/**
 * Walk the file and report the first place the chain stops adding up.
 *
 * Records written before chaining existed have no `prev` field, and a journal migrated from the old
 * location is full of them. Those are tolerated ONLY as an unbroken run at the head of the file —
 * that shape can only come from history that predates the feature. The moment a chained record
 * appears, every later record must be chained too: a missing `prev` after that point is somebody
 * stripping the field to cut a line loose, and it is reported as `unchained`.
 *
 * Found by live smoke: after the journal moved out of `.vibe/`, the migrated records made the check
 * accuse an untouched file — the exact failure this whole mechanism exists to avoid producing.
 */
export function verifyAuditChain(lines: readonly string[]): AuditChainVerdict {
	let expected = AUDIT_CHAIN_ROOT;
	let checked = 0;
	let legacyPrefix = 0;
	let sawChained = false;
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
			if (sawChained) {
				return { ok: false, line: i + 1, reason: 'unchained' };
			}
			// Pre-chain history. The next chained record links to THIS line's hash, so the chain
			// continues from the file as it actually is rather than restarting blind.
			legacyPrefix++;
			expected = auditLineHash(raw);
			continue;
		}
		if (prev !== expected) {
			return { ok: false, line: i + 1, reason: 'broken-link' };
		}
		sawChained = true;
		expected = auditLineHash(raw);
		checked++;
	}
	return legacyPrefix > 0 ? { ok: true, checked, legacyPrefix } : { ok: true, checked };
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
