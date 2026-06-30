/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Community skill-pack import verifier — pure helper.
 *
 * Roadmap §"Project Commands" community marketplace + agent-skills
 * marketplace both rely on `vibe-community-{skills,commands}-pack-v1`
 * format with SHA-256 integrity. Before applying a pack the IDE must
 * verify:
 *   - the pack envelope decodes
 *   - every entry has a non-empty id, name, content
 *   - the SHA-256 of the canonical content matches the manifest
 *
 * vscode-free: no imports beyond standard lib. Hashing itself is left to
 * the caller (the wrapper passes in `(payload, expectedSha256, computedSha256)`)
 * because Node `crypto` and Web SubtleCrypto live in different worlds —
 * the helper only does the equality check + format validation.
 */

export interface PackEntry {
	id: string;
	name: string;
	content: string;
}

export interface SkillCommunityPackEnvelope {
	formatVersion: 'vibe-community-skills-catalog-v1' | 'vibe-community-commands-pack-v1' | 'vibe-community-personas-pack-v1';
	publishedAt: number;
	entries: ReadonlyArray<PackEntry>;
	manifestSha256: Readonly<Record<string, string>>;
}

export type DecodeResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: string };

export type VerifyResult =
	| { ok: true; entries: ReadonlyArray<PackEntry> }
	| { ok: false; reason: 'envelope-invalid' | 'sha-mismatch' | 'manifest-incomplete' | 'duplicate-id'; details?: string };

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Strict envelope decoder. Pure — caller already JSON.parse'd the file.
 * Rejects malformed shapes; never throws.
 */
export function decodePackEnvelope(raw: unknown): DecodeResult<SkillCommunityPackEnvelope> {
	if (raw === null || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const obj = raw as Record<string, unknown>;
	if (
		obj.formatVersion !== 'vibe-community-skills-catalog-v1'
		&& obj.formatVersion !== 'vibe-community-commands-pack-v1'
		&& obj.formatVersion !== 'vibe-community-personas-pack-v1'
	) {
		return { ok: false, reason: 'formatVersion-unknown' };
	}
	if (typeof obj.publishedAt !== 'number' || !Number.isFinite(obj.publishedAt)) {
		return { ok: false, reason: 'publishedAt-invalid' };
	}
	if (!Array.isArray(obj.entries)) { return { ok: false, reason: 'entries-not-array' }; }
	if (obj.manifestSha256 === null || typeof obj.manifestSha256 !== 'object') {
		return { ok: false, reason: 'manifestSha256-missing' };
	}
	const entries: PackEntry[] = [];
	const seenIds = new Set<string>();
	for (let i = 0; i < obj.entries.length; i++) {
		const item = obj.entries[i];
		if (item === null || typeof item !== 'object') { return { ok: false, reason: `entries[${i}]:not-an-object` }; }
		const e = item as Record<string, unknown>;
		if (typeof e.id !== 'string' || !ID_PATTERN.test(e.id)) { return { ok: false, reason: `entries[${i}]:id-invalid` }; }
		if (typeof e.name !== 'string' || e.name.length === 0) { return { ok: false, reason: `entries[${i}]:name-missing` }; }
		if (typeof e.content !== 'string' || e.content.length === 0) { return { ok: false, reason: `entries[${i}]:content-missing` }; }
		if (seenIds.has(e.id)) { return { ok: false, reason: `entries[${i}]:duplicate-id:${e.id}` }; }
		seenIds.add(e.id);
		entries.push({ id: e.id, name: e.name, content: e.content });
	}
	const manifestSha256: Record<string, string> = {};
	for (const [k, v] of Object.entries(obj.manifestSha256 as Record<string, unknown>)) {
		if (typeof v !== 'string' || !/^[a-f0-9]{64}$/i.test(v)) {
			return { ok: false, reason: `manifestSha256.${k}:invalid-sha256` };
		}
		manifestSha256[k] = v.toLowerCase();
	}
	return {
		ok: true,
		value: { formatVersion: obj.formatVersion, publishedAt: obj.publishedAt, entries, manifestSha256 },
	};
}

export interface ComputedHash {
	id: string;
	sha256: string;
}

/**
 * Verify that every entry's expected sha256 matches the computed value.
 * Pure: caller computes the hashes (Node `crypto.createHash('sha256')`
 * or web SubtleCrypto) and passes the map.
 *
 * Returns ok-with-entries on full match, or one of:
 *   - manifest-incomplete: entry exists but no expected sha256
 *   - sha-mismatch: expected != computed
 *   - duplicate-id: same id appeared twice in the computed hashes input
 */
export function verifyPackHashes(
	envelope: SkillCommunityPackEnvelope,
	computed: ReadonlyArray<ComputedHash>,
): VerifyResult {
	const computedMap = new Map<string, string>();
	for (const c of computed) {
		if (computedMap.has(c.id)) {
			return { ok: false, reason: 'duplicate-id', details: c.id };
		}
		computedMap.set(c.id, c.sha256.toLowerCase());
	}
	for (const entry of envelope.entries) {
		const expected = envelope.manifestSha256[entry.id];
		if (typeof expected !== 'string' || expected.length === 0) {
			return { ok: false, reason: 'manifest-incomplete', details: entry.id };
		}
		const got = computedMap.get(entry.id);
		if (got === undefined) {
			return { ok: false, reason: 'manifest-incomplete', details: entry.id };
		}
		if (got !== expected.toLowerCase()) {
			return { ok: false, reason: 'sha-mismatch', details: `${entry.id}: expected=${expected} computed=${got}` };
		}
	}
	return { ok: true, entries: envelope.entries };
}
