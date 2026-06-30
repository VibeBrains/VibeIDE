/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — community marketplace catalog URL + import orchestrator
 * (roadmap §"Интеграция и community → Community Marketplace формат
 * `vibe-community-commands-pack-v1`").
 *
 * Pure helper — `vscode`-free — composes the existing primitives into one
 * tagged decision so the runtime importer becomes a thin adapter:
 *
 *   1. fetch(url) → JSON.parse → raw
 *   2. helper: `decodeCommunityCatalogUrl(setting)` → URL or refusal
 *   3. helper: `prepareCommandsPackImport({ raw, computedHashes, current })`
 *      → orchestrates envelope decode + SHA-256 verify + diff vs current
 *   4. UI shows `renderImportDiffMarkdown` and confirms before write.
 */

import {
	decodePackEnvelope,
	verifyPackHashes,
	SkillCommunityPackEnvelope,
	ComputedHash,
} from './skillPackVerifier.js';
import {
	diffCommandsForImport,
	ImportDiff,
	ProjectCommandLite,
} from './commandsImportDiff.js';

export type CommunityCatalogUrlResult =
	| { readonly kind: 'ok'; readonly url: string }
	| { readonly kind: 'unset' }
	| { readonly kind: 'invalid'; readonly reason: 'not-string' | 'empty' | 'not-https' | 'malformed' };

const MAX_URL_LEN = 4096;

/**
 * Decode `vibeide.commands.communityCatalogUrl`. Requires HTTPS — community
 * catalogs cross trust boundaries, plain HTTP is not allowed even in dev so
 * a developer never accidentally adopts an insecure default. `localhost`
 * special-case can be handled by the caller (test harness).
 */
export function decodeCommunityCatalogUrl(raw: unknown): CommunityCatalogUrlResult {
	if (raw === undefined || raw === null) {
		return { kind: 'unset' };
	}
	if (typeof raw !== 'string') {
		return { kind: 'invalid', reason: 'not-string' };
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { kind: 'unset' };
	}
	if (trimmed.length > MAX_URL_LEN) {
		return { kind: 'invalid', reason: 'malformed' };
	}
	if (!trimmed.toLowerCase().startsWith('https://')) {
		return { kind: 'invalid', reason: 'not-https' };
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { kind: 'invalid', reason: 'malformed' };
	}
	if (parsed.protocol !== 'https:') {
		return { kind: 'invalid', reason: 'not-https' };
	}
	if (parsed.hostname.length === 0) {
		return { kind: 'invalid', reason: 'malformed' };
	}
	return { kind: 'ok', url: parsed.toString() };
}

export interface PrepareCommandsPackImportInput {
	readonly raw: unknown;
	readonly computedHashes: ReadonlyArray<ComputedHash>;
	readonly currentCommands: ReadonlyArray<ProjectCommandLite>;
	readonly incomingCommandsByPackId: ReadonlyMap<string, ProjectCommandLite>;
}

export type PrepareCommandsPackImportResult =
	| { readonly kind: 'ready'; readonly envelope: SkillCommunityPackEnvelope; readonly diff: ImportDiff }
	| { readonly kind: 'wrong-format'; readonly actual: string }
	| { readonly kind: 'envelope-invalid'; readonly reason: string }
	| { readonly kind: 'verify-failed'; readonly reason: string; readonly details?: string }
	| { readonly kind: 'missing-incoming-command'; readonly id: string };

/**
 * Single entry-point. Decodes envelope, refuses non-commands packs, verifies
 * SHA-256 hashes, builds a diff vs the current `.vibe/commands.json`, and
 * returns a tagged decision so the UI can show one of:
 *   - confirm dialog with the diff (kind === 'ready')
 *   - error toast with reason (one of the three failure kinds)
 *
 * `incomingCommandsByPackId` is the pack author's parsed `ProjectCommand`
 * shapes keyed by pack-entry id — caller is expected to have already
 * extracted them from the pack `entries[i].content` (typically YAML/JSON).
 */
export function prepareCommandsPackImport(input: PrepareCommandsPackImportInput): PrepareCommandsPackImportResult {
	const decoded = decodePackEnvelope(input.raw);
	if (!decoded.ok) {
		return { kind: 'envelope-invalid', reason: decoded.reason };
	}
	if (decoded.value.formatVersion !== 'vibe-community-commands-pack-v1') {
		return { kind: 'wrong-format', actual: decoded.value.formatVersion };
	}
	const verified = verifyPackHashes(decoded.value, input.computedHashes);
	if (!verified.ok) {
		return { kind: 'verify-failed', reason: verified.reason, details: verified.details };
	}
	const incoming: ProjectCommandLite[] = [];
	for (const entry of decoded.value.entries) {
		const cmd = input.incomingCommandsByPackId.get(entry.id);
		if (cmd === undefined) {
			return { kind: 'missing-incoming-command', id: entry.id };
		}
		incoming.push(cmd);
	}
	const diff = diffCommandsForImport(input.currentCommands, incoming);
	return { kind: 'ready', envelope: decoded.value, diff };
}
