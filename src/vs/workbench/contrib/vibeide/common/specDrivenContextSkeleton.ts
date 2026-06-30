/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `VibeSpecDrivenContextService` — parser-aware spec-drift diffs
 * (roadmap §"Real-impl tail / Phase 3b — `VibeSpecDrivenContextService`
 * реальный parser diff (`swagger-parser`, `graphql-js`); breaking change
 * heuristic ловит только обвал синтаксиса, не семантику").
 *
 * `diffOpenApi` compares parsed `paths` / `components.schemas` keys for
 * removals; `diffGraphql` uses `graphql`'s `findBreakingChanges`. Both fall
 * back to the byte-size `diffSpecHeuristic` when input is not parseable
 * (YAML / malformed) or the `graphql` package is absent — so callers always
 * receive a stable `SpecDiffResult` shape and never throw.
 */

export type SpecKind = 'openapi' | 'graphql';

export type BreakingChangeSeverity = 'major' | 'minor' | 'patch' | 'unknown';

export interface SpecDriftEntry {
	readonly kind: SpecKind;
	readonly path: string;
	readonly summary: string;
	readonly severity: BreakingChangeSeverity;
}

export interface SpecDiffInput {
	readonly kind: SpecKind;
	readonly oldText: string;
	readonly newText: string;
}

export interface SpecDiffResult {
	readonly entries: ReadonlyArray<SpecDriftEntry>;
	readonly hasBreaking: boolean;
}

/**
 * Pure: classify a syntax-only diff as breaking-or-not. This is the
 * fail-loud heuristic the existing service uses — kept here so a switch
 * to the real parser-aware diff is a one-line replacement at the call
 * site (the diff entry shape is stable).
 *
 * Heuristic rules (collect-all-failures style):
 *   - non-trivial size shrink (>20% bytes) → 'major'
 *   - non-trivial size growth (>200% bytes) → 'minor'
 *   - 0-byte input → 'unknown' (caller decides what to do)
 *   - identical inputs → empty `entries`, hasBreaking = false
 *
 * The real parser-aware `diffOpenApi` / `diffGraphql` will replace this
 * helper but keep the same return shape.
 */
export function diffSpecHeuristic(input: SpecDiffInput): SpecDiffResult {
	const oldLen = input.oldText.length;
	const newLen = input.newText.length;

	if (oldLen === 0 || newLen === 0) {
		return {
			entries: [{
				kind: input.kind,
				path: '<root>',
				summary: oldLen === 0 ? 'spec text was empty before; cannot diff semantics' : 'spec text became empty; full removal',
				severity: 'unknown',
			}],
			hasBreaking: oldLen > 0 && newLen === 0,
		};
	}

	if (input.oldText === input.newText) {
		return { entries: [], hasBreaking: false };
	}

	const ratio = newLen / oldLen;
	const entries: SpecDriftEntry[] = [];
	if (ratio < 0.8) {
		entries.push({
			kind: input.kind,
			path: '<root>',
			summary: `spec shrank ${(100 - ratio * 100).toFixed(1)}% (heuristic — likely removed endpoints/types)`,
			severity: 'major',
		});
	} else if (ratio > 3) {
		entries.push({
			kind: input.kind,
			path: '<root>',
			summary: `spec grew ${(ratio * 100 - 100).toFixed(1)}% (heuristic — likely added endpoints/types)`,
			severity: 'minor',
		});
	} else {
		entries.push({
			kind: input.kind,
			path: '<root>',
			summary: 'spec changed within size bounds; semantic diff not yet implemented',
			severity: 'patch',
		});
	}
	return { entries, hasBreaking: entries.some(e => e.severity === 'major') };
}

/**
 * Real OpenAPI diff: parses both specs as JSON objects and compares
 * top-level `paths` keys and `components.schemas` keys for removals.
 * Falls back to heuristic if parsing fails (YAML or malformed input).
 */
export function diffOpenApi(input: { oldSpec: string; newSpec: string }): SpecDiffResult {
	let oldObj: Record<string, unknown> | undefined;
	let newObj: Record<string, unknown> | undefined;
	try { oldObj = JSON.parse(input.oldSpec); } catch { /* yaml or malformed — fall through */ }
	try { newObj = JSON.parse(input.newSpec); } catch { /* yaml or malformed — fall through */ }

	if (!oldObj || !newObj) {
		return diffSpecHeuristic({ kind: 'openapi', oldText: input.oldSpec, newText: input.newSpec });
	}

	const entries: SpecDriftEntry[] = [];

	const oldPaths = Object.keys((oldObj['paths'] as Record<string, unknown>) ?? {});
	const newPaths = new Set(Object.keys((newObj['paths'] as Record<string, unknown>) ?? {}));
	for (const p of oldPaths) {
		if (!newPaths.has(p)) {
			entries.push({ kind: 'openapi', path: p, summary: `path removed: ${p}`, severity: 'major' });
		}
	}

	const oldSchemas = Object.keys(((oldObj['components'] as Record<string, unknown>)?.['schemas'] as Record<string, unknown>) ?? {});
	const newSchemas = new Set(Object.keys(((newObj['components'] as Record<string, unknown>)?.['schemas'] as Record<string, unknown>) ?? {}));
	for (const s of oldSchemas) {
		if (!newSchemas.has(s)) {
			entries.push({ kind: 'openapi', path: `#/components/schemas/${s}`, summary: `schema removed: ${s}`, severity: 'major' });
		}
	}

	return { entries, hasBreaking: entries.some(e => e.severity === 'major') };
}

/**
 * Real GraphQL diff: uses `graphql` package's `buildSchema` + `findBreakingChanges`
 * for semantic breaking-change detection. Falls back to heuristic on parse error.
 */
export function diffGraphql(input: { oldSpec: string; newSpec: string }): SpecDiffResult {
	// Dynamic require so common/ stays importable in browser test environments;
	// at runtime (Electron desktop / Node) the package is always present.
	let findBreakingChanges: ((old: unknown, next: unknown) => Array<{ description: string }>) | undefined;
	let buildSchema: ((sdl: string) => unknown) | undefined;
	try {

		const gql = require('graphql') as { buildSchema: typeof buildSchema; findBreakingChanges: typeof findBreakingChanges };
		buildSchema = gql.buildSchema;
		findBreakingChanges = gql.findBreakingChanges;
	} catch {
		return diffSpecHeuristic({ kind: 'graphql', oldText: input.oldSpec, newText: input.newSpec });
	}

	let oldSchema: unknown;
	let newSchema: unknown;
	try { oldSchema = buildSchema!(input.oldSpec); } catch {
		return diffSpecHeuristic({ kind: 'graphql', oldText: input.oldSpec, newText: input.newSpec });
	}
	try { newSchema = buildSchema!(input.newSpec); } catch {
		return { entries: [{ kind: 'graphql', path: '<root>', summary: 'new schema failed to parse', severity: 'major' }], hasBreaking: true };
	}

	const breaking = findBreakingChanges!(oldSchema, newSchema);
	const entries: SpecDriftEntry[] = breaking.map(b => ({
		kind: 'graphql' as SpecKind,
		path: '<schema>',
		summary: b.description,
		severity: 'major' as BreakingChangeSeverity,
	}));
	return { entries, hasBreaking: entries.length > 0 };
}

/**
 * Map heuristic verdict to a UI-friendly RU label.
 */
export function describeSeverity(severity: BreakingChangeSeverity): string {
	switch (severity) {
		case 'major': return 'Критичные изменения';
		case 'minor': return 'Совместимые добавления';
		case 'patch': return 'Несущественные правки';
		case 'unknown': return 'Не удалось определить';
	}
}
