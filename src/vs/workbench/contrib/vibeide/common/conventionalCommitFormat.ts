/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Conventional Commits helpers (pure, no DI, no I/O). Used by the `/commit`
 * chat slash command (roadmap §"chat-only commits") and the
 * `generate_commit_message` tool. UI wire-up + git diff fetching are wave-2
 * (browser session); the analysis logic lives here so it can be unit-tested
 * in isolation.
 *
 * Spec: https://www.conventionalcommits.org/en/v1.0.0/
 */

export type ConventionalCommitType =
	| 'feat'
	| 'fix'
	| 'docs'
	| 'style'
	| 'refactor'
	| 'perf'
	| 'test'
	| 'chore'
	| 'build'
	| 'ci'
	| 'revert';

export interface ConventionalCommit {
	readonly type: ConventionalCommitType;
	readonly scope?: string;
	readonly subject: string;
	readonly body?: string;
	readonly breaking?: boolean;
	readonly footers?: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

const VALID_TYPES: ReadonlySet<ConventionalCommitType> = new Set([
	'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test',
	'chore', 'build', 'ci', 'revert',
] as const);

/**
 * Format a `ConventionalCommit` into its canonical single-string form:
 *
 *   type(scope)!: subject
 *   <blank line>
 *   body
 *   <blank line>
 *   BREAKING CHANGE: …
 *   Refs: #123
 *
 * Subject is single-line, ≤ 72 chars (truncated with `…` if longer).
 * Body lines wrap at 100 chars (preserves intentional newlines).
 */
export function formatConventionalCommit(commit: ConventionalCommit): string {
	const scopeSuffix = commit.scope ? `(${commit.scope})` : '';
	const breakingMark = commit.breaking ? '!' : '';
	const subjectLine = truncateSubject(commit.subject);
	const header = `${commit.type}${scopeSuffix}${breakingMark}: ${subjectLine}`;

	const parts: string[] = [header];
	if (commit.body && commit.body.trim()) {
		parts.push('', wrapBody(commit.body, 100));
	}
	if (commit.footers && commit.footers.length > 0) {
		parts.push('');
		for (const { key, value } of commit.footers) {
			parts.push(`${key}: ${value}`);
		}
	}
	return parts.join('\n');
}

/**
 * Parse a commit message string back into structured form. Returns null on
 * malformed input (missing type/colon, unknown type). Used to validate
 * LLM-generated messages before applying.
 */
export function parseConventionalCommit(raw: string): ConventionalCommit | null {
	if (typeof raw !== 'string') { return null; }
	const trimmed = raw.trim();
	if (!trimmed) { return null; }
	const lines = trimmed.split(/\r?\n/);
	const header = lines[0];
	// `type(scope)!: subject` with optional scope and breaking marker.
	const m = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/.exec(header);
	if (!m) { return null; }
	const type = m[1] as ConventionalCommitType;
	if (!VALID_TYPES.has(type)) { return null; }
	const scope = m[2]?.trim() || undefined;
	const breaking = !!m[3];
	const subject = m[4].trim();
	if (!subject) { return null; }

	const remaining = lines.slice(1).join('\n').trim();
	if (!remaining) {
		return { type, scope, breaking, subject };
	}
	// Footer block: trailing lines matching `Key: value` pattern.
	const footers: { key: string; value: string }[] = [];
	const bodyLines: string[] = [];
	const blocks = remaining.split(/\n\s*\n/);
	const lastBlock = blocks[blocks.length - 1];
	const footerRe = /^([A-Za-z][\w-]*|BREAKING CHANGE):\s+(.+)$/;
	let footerBlockClaimed = false;
	if (lastBlock) {
		const lastLines = lastBlock.split('\n');
		if (lastLines.every(l => footerRe.test(l))) {
			for (const l of lastLines) {
				const fm = footerRe.exec(l)!;
				footers.push({ key: fm[1], value: fm[2] });
			}
			footerBlockClaimed = true;
		}
	}
	const bodyBlocks = footerBlockClaimed ? blocks.slice(0, -1) : blocks;
	bodyLines.push(bodyBlocks.join('\n\n'));
	const body = bodyLines.join('\n').trim() || undefined;

	return { type, scope, breaking, subject, body, footers: footers.length > 0 ? footers : undefined };
}

/**
 * Auto-detect a scope from a list of changed file paths. Strategy:
 *
 *  1. If all paths share a common prefix segment under a recognized convention
 *     (`src/vs/workbench/contrib/<contrib>/...` → `<contrib>`,
 *     `extensions/<name>/...` → `<name>`, `docs/<topic>/...` → `docs`), use it.
 *  2. Otherwise return undefined (caller can leave scope empty or pick one).
 *
 * Returns canonical-snake-case scope name. Case-insensitive matching.
 */
export function autoDetectScope(changedPaths: readonly string[]): string | undefined {
	if (changedPaths.length === 0) { return undefined; }
	const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.+\//, '');
	const paths = changedPaths.map(norm);

	// Try `src/vs/workbench/contrib/<contrib>/...` first (VibeIDE's main code area).
	const contribRe = /^src\/vs\/workbench\/contrib\/([a-z][\w-]*)\//i;
	const contribs = new Set<string>();
	let contribAll = true;
	for (const p of paths) {
		const m = contribRe.exec(p);
		if (m) { contribs.add(m[1].toLowerCase()); }
		else { contribAll = false; }
	}
	if (contribAll && contribs.size === 1) {
		return [...contribs][0];
	}

	// Try `extensions/<name>/...`.
	const extRe = /^extensions\/([a-z][\w-]*)\//i;
	const exts = new Set<string>();
	let extAll = true;
	for (const p of paths) {
		const m = extRe.exec(p);
		if (m) { exts.add(m[1].toLowerCase()); }
		else { extAll = false; }
	}
	if (extAll && exts.size === 1) {
		return [...exts][0];
	}

	// Try `docs/<topic>/...` → 'docs' (umbrella).
	const docsRe = /^docs\//;
	if (paths.every(p => docsRe.test(p))) { return 'docs'; }

	// Try `scripts/...` → 'scripts'.
	if (paths.every(p => p.startsWith('scripts/'))) { return 'scripts'; }

	// Try `.github/workflows/...` → 'ci'.
	if (paths.every(p => p.startsWith('.github/workflows/'))) { return 'ci'; }

	return undefined;
}

/**
 * Heuristically detect the most likely commit type from a unified diff body.
 * Used to pre-fill the `type` field before LLM analysis. Returns `chore` as
 * the conservative default.
 */
export function autoDetectType(diff: string, changedPaths: readonly string[]): ConventionalCommitType {
	if (typeof diff !== 'string') { return 'chore'; }
	const allDocs = changedPaths.length > 0 && changedPaths.every(p => /\.md$/.test(p) || p.startsWith('docs/'));
	if (allDocs) { return 'docs'; }
	const allTests = changedPaths.length > 0 && changedPaths.every(p => /\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|\/test\//.test(p));
	if (allTests) { return 'test'; }
	const allCi = changedPaths.length > 0 && changedPaths.every(p => p.startsWith('.github/workflows/') || p === '.github/dependabot.yml');
	if (allCi) { return 'ci'; }
	const allBuild = changedPaths.length > 0 && changedPaths.every(p => /^(package\.json|package-lock\.json|tsconfig.*\.json|gulpfile\.js|build\/)/.test(p));
	if (allBuild) { return 'build'; }

	// Diff body heuristics.
	if (/^[+-]\s*\/\/\s*TODO|^[+-]\s*\/\*\s*TODO/m.test(diff)) {
		// TODO additions/removals — usually refactor or chore.
	}
	const hasFixWords = /\b(fix|bug|crash|undefined|null pointer|error|exception)\b/i.test(diff);
	const hasFeatureWords = /\b(add|new feature|implement|introduce)\b/i.test(diff);
	if (hasFixWords && !hasFeatureWords) { return 'fix'; }
	if (hasFeatureWords) { return 'feat'; }

	return 'chore';
}

function truncateSubject(subject: string): string {
	const s = subject.trim().replace(/\s+/g, ' ');
	if (s.length <= 72) { return s; }
	return s.slice(0, 71) + '…';
}

function wrapBody(body: string, width: number): string {
	const paragraphs = body.split(/\n\n+/);
	const wrapped = paragraphs.map(p => {
		const oneLine = p.replace(/\s*\n\s*/g, ' ').trim();
		if (oneLine.length <= width) { return oneLine; }
		const words = oneLine.split(' ');
		const lines: string[] = [];
		let cur = '';
		for (const w of words) {
			if (cur.length === 0) { cur = w; }
			else if (cur.length + 1 + w.length <= width) { cur += ' ' + w; }
			else { lines.push(cur); cur = w; }
		}
		if (cur) { lines.push(cur); }
		return lines.join('\n');
	});
	return wrapped.join('\n\n');
}
