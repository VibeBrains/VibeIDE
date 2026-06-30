/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Memory layer routing decision (1060) — pure helper.
 *
 * VibeIDE has three memory layers (see docs/knowledge.md → "L.1 Orphan
 * services"):
 *
 *   - explicit  → `memoriesService` (user-pinned, manual CRUD)
 *   - long-term → `vibeMemoryDecayService` → `.vibe/context.md` (auto-
 *                 summarised key decisions, persists across machines via git)
 *   - short-term → `sessionMemoryPerThread` (IDE storage only, decays in 7d
 *                  or on closeThread)
 *
 * When the agent or user wants to write a new memory, this helper decides
 * which layer it belongs to. Inputs are tags / context flags; output is
 * a typed routing decision plus an explanation suitable for an audit
 * log entry.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type MemoryLayer = 'explicit' | 'long-term' | 'short-term';

export interface MemoryRoutingInput {
	/** True when the user explicitly typed "remember this" or saved manually. */
	userExplicit: boolean;
	/** True when the fact is workspace-scoped (will move with the repo). */
	workspaceScoped: boolean;
	/** True when the fact is only useful within the current chat thread. */
	threadOnly: boolean;
	/** Optional age estimate — facts about today's task should not pollute Project Brain. */
	ttlHintMs?: number;
}

export interface MemoryRoutingDecision {
	layer: MemoryLayer;
	reason: string;
	/** Suggested expires-at timestamp; absent for explicit / long-term. */
	expiresAtHint?: number;
}

export const SHORT_TERM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Decide which memory layer should accept the write. Pure.
 *
 * Decision priority:
 *   1. userExplicit → explicit (user CRUD wins over auto-routing).
 *   2. threadOnly OR ttlHint < 1d → short-term.
 *   3. workspaceScoped → long-term (Project Brain, persists via git).
 *   4. fallback → short-term (safer than polluting Project Brain with
 *      unscoped facts).
 */
export function routeMemoryWrite(input: MemoryRoutingInput, now: number): MemoryRoutingDecision {
	if (input.userExplicit) {
		return { layer: 'explicit', reason: 'user-explicit-save' };
	}
	if (input.threadOnly || (typeof input.ttlHintMs === 'number' && input.ttlHintMs < 24 * 60 * 60 * 1000)) {
		return {
			layer: 'short-term',
			reason: input.threadOnly ? 'thread-scoped' : 'ttl-under-1-day',
			expiresAtHint: now + (input.ttlHintMs ?? SHORT_TERM_TTL_MS),
		};
	}
	if (input.workspaceScoped) {
		return { layer: 'long-term', reason: 'workspace-scoped-fact' };
	}
	return {
		layer: 'short-term',
		reason: 'fallback-no-explicit-scope',
		expiresAtHint: now + SHORT_TERM_TTL_MS,
	};
}

export interface DriftWarning {
	kind: 'duplicate-across-layers' | 'long-term-without-workspace' | 'short-term-with-workspace';
	memoryId: string;
	layer: MemoryLayer;
	hint: string;
}

export interface MemoryRecord {
	id: string;
	layer: MemoryLayer;
	content: string;
	workspaceScoped: boolean;
}

/**
 * Audit a snapshot of memory records and surface drift between layers:
 *   - same `content` in two layers → duplicate-across-layers
 *   - long-term entry without workspaceScoped flag → long-term-without-workspace
 *   - short-term entry that IS workspaceScoped → short-term-with-workspace
 *     (might belong in long-term)
 *
 * Pure. Returns warnings; the runtime decides whether to surface a
 * banner or just log them.
 */
export function auditMemoryLayers(records: ReadonlyArray<MemoryRecord>): DriftWarning[] {
	const warnings: DriftWarning[] = [];
	const byContent = new Map<string, MemoryRecord[]>();
	for (const r of records) {
		const key = normaliseContent(r.content);
		const list = byContent.get(key) ?? [];
		list.push(r);
		byContent.set(key, list);
	}
	for (const [, list] of byContent.entries()) {
		if (list.length > 1) {
			const layers = new Set(list.map(r => r.layer));
			if (layers.size > 1) {
				warnings.push({
					kind: 'duplicate-across-layers',
					memoryId: list[0].id,
					layer: list[0].layer,
					hint: `Same content in layers: ${[...layers].join(', ')}.`,
				});
			}
		}
	}
	for (const r of records) {
		if (r.layer === 'long-term' && !r.workspaceScoped) {
			warnings.push({
				kind: 'long-term-without-workspace',
				memoryId: r.id,
				layer: r.layer,
				hint: 'Long-term entries should be workspace-scoped (move to short-term or set workspaceScoped=true).',
			});
		}
		if (r.layer === 'short-term' && r.workspaceScoped) {
			warnings.push({
				kind: 'short-term-with-workspace',
				memoryId: r.id,
				layer: r.layer,
				hint: 'Workspace-scoped fact in short-term layer — likely belongs in Project Brain.',
			});
		}
	}
	return warnings;
}

function normaliseContent(s: string): string {
	return s.trim().replace(/\s+/g, ' ').toLowerCase();
}
