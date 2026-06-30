/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Personas marketplace — catalog URL + import orchestrator
 * (roadmap §"L.6 — Personas marketplace: если `vibePersonaService.ts`
 * останется отдельной системой, добавить community personas (паттерн как
 * Skills): `.vibe/personas/<id>/persona.md`, signing, import").
 *
 * Pure helpers — `vscode`-free — composes existing primitives into one
 * tagged decision so the runtime importer becomes a thin adapter. Mirror
 * of `projectCommandsCommunityCatalog.ts` (which orchestrates the same
 * pipeline for Project Commands packs); the personas pack uses the
 * `vibe-community-personas-pack-v1` formatVersion sibling.
 */

import {
	decodePackEnvelope,
	verifyPackHashes,
	SkillCommunityPackEnvelope,
	ComputedHash,
} from './skillPackVerifier.js';

const PERSONA_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export interface PersonaLite {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly mode?: 'agent' | 'plan' | 'chat' | 'explore';
	readonly systemPromptHash: string;
}

export type CommunityCatalogUrlResult =
	| { readonly kind: 'ok'; readonly url: string }
	| { readonly kind: 'unset' }
	| { readonly kind: 'invalid'; readonly reason: 'not-string' | 'empty' | 'not-https' | 'malformed' };

const MAX_URL_LEN = 4096;

/**
 * Decode `vibeide.personas.communityCatalogUrl`. HTTPS-only; community
 * catalogs cross trust boundaries — even dev never accepts HTTP. Same
 * shape as `decodeCommunityCatalogUrl` in projectCommandsCommunityCatalog
 * but kept separate so the two settings can evolve independently.
 */
export function decodePersonasCatalogUrl(raw: unknown): CommunityCatalogUrlResult {
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

export type PersonaImportItemKind = 'added' | 'modified' | 'unchanged';

export interface PersonaImportItem {
	readonly id: string;
	readonly kind: PersonaImportItemKind;
	readonly before?: PersonaLite;
	readonly after: PersonaLite;
}

export interface PersonasImportDiff {
	readonly items: readonly PersonaImportItem[];
	readonly stats: {
		readonly added: number;
		readonly modified: number;
		readonly unchanged: number;
	};
	/** True iff at least one persona introduces or changes the system prompt. */
	readonly touchesSystemPrompt: boolean;
}

/**
 * Pure: per-id diff between current `.vibe/personas/` and the incoming
 * pack. `systemPromptHash` is the field that drives sensitivity — a
 * persona changing the system prompt is a security-significant event.
 */
export function diffPersonasForImport(
	current: ReadonlyArray<PersonaLite>,
	incoming: ReadonlyArray<PersonaLite>,
): PersonasImportDiff {
	const byId = new Map<string, PersonaLite>();
	for (const c of current) { byId.set(c.id, c); }
	const items: PersonaImportItem[] = [];
	let added = 0, modified = 0, unchanged = 0;
	let touchesSystemPrompt = false;
	const seen = new Set<string>();
	for (const inc of incoming) {
		if (seen.has(inc.id)) { continue; }
		seen.add(inc.id);
		const cur = byId.get(inc.id);
		if (cur === undefined) {
			items.push({ id: inc.id, kind: 'added', after: inc });
			added++;
			touchesSystemPrompt = true;
			continue;
		}
		if (cur.systemPromptHash !== inc.systemPromptHash || cur.name !== inc.name || cur.mode !== inc.mode) {
			items.push({ id: inc.id, kind: 'modified', before: cur, after: inc });
			modified++;
			if (cur.systemPromptHash !== inc.systemPromptHash) { touchesSystemPrompt = true; }
			continue;
		}
		items.push({ id: inc.id, kind: 'unchanged', before: cur, after: inc });
		unchanged++;
	}
	return {
		items,
		stats: { added, modified, unchanged },
		touchesSystemPrompt,
	};
}

export type PreparePersonasImportResult =
	| { readonly kind: 'ready'; readonly envelope: SkillCommunityPackEnvelope; readonly diff: PersonasImportDiff }
	| { readonly kind: 'wrong-format'; readonly actual: string }
	| { readonly kind: 'envelope-invalid'; readonly reason: string }
	| { readonly kind: 'verify-failed'; readonly reason: string; readonly details?: string }
	| { readonly kind: 'missing-incoming-persona'; readonly id: string }
	| { readonly kind: 'persona-id-malformed'; readonly id: string };

export interface PreparePersonasImportInput {
	readonly raw: unknown;
	readonly computedHashes: ReadonlyArray<ComputedHash>;
	readonly currentPersonas: ReadonlyArray<PersonaLite>;
	readonly incomingPersonasByPackId: ReadonlyMap<string, PersonaLite>;
}

/**
 * Single entry-point. Decodes envelope, refuses non-personas packs,
 * verifies SHA-256, validates persona ids, builds a diff. Returns a
 * tagged decision so the UI shows one of:
 *   - confirm dialog with the diff (kind === 'ready')
 *   - error toast with reason (one of the failure kinds)
 */
export function preparePersonasImport(input: PreparePersonasImportInput): PreparePersonasImportResult {
	const decoded = decodePackEnvelope(input.raw);
	if (!decoded.ok) {
		return { kind: 'envelope-invalid', reason: decoded.reason };
	}
	const accepted: ReadonlyArray<string> = ['vibe-community-personas-pack-v1'] as const;
	if (!accepted.includes(decoded.value.formatVersion as string)) {
		return { kind: 'wrong-format', actual: decoded.value.formatVersion };
	}
	const verified = verifyPackHashes(decoded.value, input.computedHashes);
	if (!verified.ok) {
		return { kind: 'verify-failed', reason: verified.reason, details: verified.details };
	}
	const incoming: PersonaLite[] = [];
	for (const entry of decoded.value.entries) {
		if (!PERSONA_ID_PATTERN.test(entry.id)) {
			return { kind: 'persona-id-malformed', id: entry.id };
		}
		const persona = input.incomingPersonasByPackId.get(entry.id);
		if (persona === undefined) {
			return { kind: 'missing-incoming-persona', id: entry.id };
		}
		incoming.push(persona);
	}
	const diff = diffPersonasForImport(input.currentPersonas, incoming);
	return { kind: 'ready', envelope: decoded.value, diff };
}

/**
 * Render the import diff as RU markdown for the confirm dialog. Pure.
 */
export function renderPersonasDiffMarkdown(diff: PersonasImportDiff): string {
	const lines: string[] = [];
	lines.push(`Импорт персон: ${diff.stats.added} добавлено, ${diff.stats.modified} изменено, ${diff.stats.unchanged} без изменений.`);
	if (diff.touchesSystemPrompt) {
		lines.push('');
		lines.push('⚠️ Изменения затрагивают **system prompt** — внимательно прочтите перед импортом.');
	}
	const changes = diff.items.filter(i => i.kind !== 'unchanged');
	if (changes.length > 0) {
		lines.push('');
		lines.push('### Изменения');
		for (const item of changes.slice(0, 20)) {
			const marker = item.kind === 'added' ? '➕' : '✏️';
			const mode = item.after.mode ? ` (${item.after.mode})` : '';
			lines.push(`${marker} \`${item.id}\` — ${item.after.name}${mode}`);
		}
		if (changes.length > 20) {
			lines.push(`…и ещё ${changes.length - 20}`);
		}
	}
	return lines.join('\n');
}
