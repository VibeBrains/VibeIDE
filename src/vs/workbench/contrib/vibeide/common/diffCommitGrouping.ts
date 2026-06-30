/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * AI commit grouping (932) — pure heuristic splitter.
 *
 * Takes a list of changed files and groups them into Conventional Commits-
 * shaped buckets without an LLM in the loop. The downstream (Ollama-driven)
 * commit-message generator is a separate step; this module only decides the
 * partition. Heuristic categorisation:
 *
 *   src test files       → "test"
 *   docs/, markdown      → "docs"
 *   .github/workflows/   → "ci"
 *   package.json + locks → "build"
 *   .css / .scss         → "style"
 *   anything else        → "feat" (single bucket per top-level dir to keep it tight)
 *
 * vscode-free: no imports beyond standard lib.
 */

export type CommitType = 'feat' | 'fix' | 'test' | 'docs' | 'ci' | 'build' | 'style' | 'refactor' | 'chore';

export interface DiffFileChange {
	path: string;
	/** True if the file is brand-new in this diff (tracked by `git status -- A`). */
	isNew?: boolean;
	/** True if the file was deleted. */
	isDeleted?: boolean;
}

export interface CommitGroup {
	type: CommitType;
	scope?: string;
	files: ReadonlyArray<DiffFileChange>;
}

/**
 * Partition `changes` into commit-shaped groups. Pure.
 *
 * Bucketing rules in priority order; first match wins:
 *   1. CI workflow files → ci(workflows)
 *   2. lockfiles / package.json / tsconfig.json → build(deps)
 *   3. Markdown / docs/** → docs
 *   4. *.test.ts / test/** → test
 *   5. *.css / *.scss → style
 *   6. Otherwise → feat, scope = first path segment of `src/<scope>/...`
 *
 * Empty input yields an empty group list. Files with empty `path` are skipped.
 */
export function groupDiffByCommitType(changes: ReadonlyArray<DiffFileChange>): CommitGroup[] {
	const buckets = new Map<string, DiffFileChange[]>();
	const order: string[] = [];

	for (const change of changes) {
		if (!change || typeof change.path !== 'string' || change.path.length === 0) { continue; }
		const { type, scope } = classifyChange(change.path);
		const key = `${type}|${scope ?? ''}`;
		if (!buckets.has(key)) {
			buckets.set(key, []);
			order.push(key);
		}
		buckets.get(key)!.push(change);
	}

	const result: CommitGroup[] = [];
	for (const key of order) {
		const [type, scopePart] = key.split('|') as [CommitType, string];
		const files = buckets.get(key)!;
		const group: CommitGroup = { type, files };
		if (scopePart.length > 0) {
			group.scope = scopePart;
		}
		result.push(group);
	}
	return result;
}

function classifyChange(path: string): { type: CommitType; scope?: string } {
	const p = path.replace(/\\/g, '/');
	if (p.startsWith('.github/workflows/') || p === '.github/dependabot.yml') {
		return { type: 'ci', scope: 'workflows' };
	}
	if (p === 'package.json' || p === 'package-lock.json' || p === 'pnpm-lock.yaml' || p === 'yarn.lock' || p === 'tsconfig.json') {
		return { type: 'build', scope: 'deps' };
	}
	if (/\.md$/i.test(p) || p.startsWith('docs/')) {
		return { type: 'docs' };
	}
	if (/(^|\/)test\//.test(p) || /\.test\.tsx?$/.test(p) || /\.spec\.tsx?$/.test(p)) {
		return { type: 'test' };
	}
	if (/\.(css|scss|less)$/i.test(p)) {
		return { type: 'style' };
	}
	// feat scope = first segment under src/, otherwise the top-level segment.
	const srcMatch = p.match(/^src\/([^/]+)\//);
	if (srcMatch) {
		return { type: 'feat', scope: srcMatch[1] };
	}
	const top = p.split('/')[0];
	return { type: 'feat', scope: top || undefined };
}

/**
 * Build a Conventional-Commits message stub from a group. Pure.
 *
 *   feat(workbench): edit 4 files
 *   ci(workflows): add 1 file
 *
 * The actual commit message body / model call is the consumer's job — this
 * helper just produces the type-scope-summary stub so unit tests stay
 * deterministic.
 */
export function renderGroupStub(group: CommitGroup): string {
	const verb = pickVerb(group.files);
	const head = group.scope ? `${group.type}(${group.scope})` : group.type;
	return `${head}: ${verb} ${group.files.length} file${group.files.length === 1 ? '' : 's'}`;
}

function pickVerb(files: ReadonlyArray<DiffFileChange>): string {
	const allNew = files.length > 0 && files.every(f => f.isNew);
	if (allNew) { return 'add'; }
	const allDeleted = files.length > 0 && files.every(f => f.isDeleted);
	if (allDeleted) { return 'remove'; }
	return 'edit';
}
