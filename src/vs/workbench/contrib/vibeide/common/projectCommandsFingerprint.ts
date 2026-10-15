/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProjectCommand } from './projectCommandsTypes.js';

/**
 * Project Commands — what a run approval is bound to, and where it is kept.
 *
 * The approval lives in the IDE storage of the profile, outside the repository.
 * A file inside the repository arrives with the same pull request that brought the command,
 * so the repository would approve its own command; a 32-bit hash made it a matter of seconds.
 *
 * The fingerprint is shared in shape with VibeIDEA (same fields, same separators, SHA-256, 32 hex chars).
 * The stores are not shared: an approval given in one IDE must not count in the other.
 */

/** Unit separator between items of one field (args, env pairs). */
const FIELD_SEPARATOR = '\x1f';
/** Record separator between fields. */
const RECORD_SEPARATOR = '\x1e';
/** Hex chars kept from the SHA-256 digest: 128 bits, far beyond what a collision attack needs. */
const FINGERPRINT_HEX_CHARS = 32;

/** Storage key prefix; the folder URI of the project follows. */
const TRUST_STORAGE_KEY_PREFIX = 'vibeide.commands.trust:';

/** Fields of a command that decide what runs. A new title or color does not revoke an approval. */
export type FingerprintedCommand = Pick<ProjectCommand, 'id' | 'command' | 'args' | 'cwd' | 'env' | 'shell'>;

/**
 * The string the digest is taken over.
 * Env keys are ordered by UTF-16 code units, not by locale: the order must not depend on the machine.
 */
export function commandShapeString(c: FingerprintedCommand): string {
	const env = Object.entries(c.env ?? {})
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join(FIELD_SEPARATOR);
	return [
		c.id,
		c.command,
		(c.args ?? []).join(FIELD_SEPARATOR),
		c.cwd ?? '',
		env,
		c.shell ? '1' : '0',
	].join(RECORD_SEPARATOR);
}

/** SHA-256 over the shape of the command, as hex, cut to `FINGERPRINT_HEX_CHARS`. */
export async function commandFingerprint(c: FingerprintedCommand): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(commandShapeString(c)));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, FINGERPRINT_HEX_CHARS);
}

/** Key of the approvals of one project folder in the profile storage. */
export function commandTrustStorageKey(folderUri: string): string {
	return TRUST_STORAGE_KEY_PREFIX + folderUri;
}
