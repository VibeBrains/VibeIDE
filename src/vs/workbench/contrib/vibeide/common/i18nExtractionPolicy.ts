/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * i18n extraction policy — pure path classifier
 * (roadmap §"Pack VSIX → Шаблоны Skill-промптов `.vibe/skills/*.md` —
 * исключаем из i18n (это контент, не UI; язык выбирает автор скилла)").
 *
 * Pure helper — `vscode`-free — declares which paths should be EXCLUDED
 * from `localize()` extraction. Used by:
 *   - `extract-vibeide-locale-strings` gulp task to skip non-UI sources
 *   - `i18n-lint.yml` workflow to skip warnings on excluded paths
 *   - `vibe doctor --i18n` reporting to ignore excluded files in coverage %
 *
 * The policy lives here (not in roadmap text) so future additions are
 * one PR away from a unit test, not a doc edit.
 */

export type I18nExclusionReason =
	| 'skill-prompt-template'
	| 'persona-template'
	| 'workflow-yaml'
	| 'react-out-bundle'
	| 'test-fixture'
	| 'snapshot-file'
	| 'build-artifact'
	| 'docs-only'
	| 'community-pack-content';

export interface I18nExclusionVerdict {
	readonly excluded: boolean;
	readonly reason?: I18nExclusionReason;
}

interface ExclusionRule {
	readonly reason: I18nExclusionReason;
	readonly test: (path: string) => boolean;
}

const RULES: ReadonlyArray<ExclusionRule> = [
	{
		reason: 'skill-prompt-template',
		test: (p) => /(\.vibe[/\\])?skills[/\\][^/\\]+[/\\]SKILL\.md$/i.test(p) || /\.vibe[/\\]prompts[/\\][^/\\]+\.md$/i.test(p),
	},
	{
		reason: 'persona-template',
		test: (p) => /\.vibe[/\\]personas[/\\][^/\\]+[/\\]persona\.md$/i.test(p),
	},
	{
		reason: 'workflow-yaml',
		test: (p) => /\.vibe[/\\]workflows[/\\][^/\\]+\.ya?ml$/i.test(p),
	},
	{
		reason: 'react-out-bundle',
		test: (p) => /[\\/]react[\\/]out[\\/]/i.test(p),
	},
	{
		reason: 'test-fixture',
		test: (p) => /[\\/]test[\\/].*\.(test|fixture)\.(ts|tsx|js)$/i.test(p),
	},
	{
		reason: 'snapshot-file',
		test: (p) => /\.snap$|__snapshots__[\\/]/i.test(p),
	},
	{
		reason: 'build-artifact',
		test: (p) => /^(out[\\/]|\.build[\\/]|dist[\\/]|build[\\/]lib[\\/]|node_modules[\\/])/i.test(p),
	},
	{
		reason: 'docs-only',
		test: (p) => /^docs[\\/].*\.md$/i.test(p) || /^references[\\/].*\.md$/i.test(p),
	},
	{
		reason: 'community-pack-content',
		test: (p) => /\.vibe[/\\](skills|commands)[/\\].*[/\\](content|README)\.md$/i.test(p),
	},
];

/**
 * Decide if a workspace-relative path should be excluded from i18n
 * extraction. Pure — first-rule-wins.
 *
 * Path normalisation: caller should pass a workspace-relative POSIX or
 * Windows-style path. Helper accepts both `/` and `\` separators.
 */
export function decideI18nExclusion(workspaceRelativePath: string): I18nExclusionVerdict {
	if (typeof workspaceRelativePath !== 'string' || workspaceRelativePath.length === 0) {
		return { excluded: false };
	}
	const normalised = workspaceRelativePath.replace(/^[/\\]+/, '');
	for (const rule of RULES) {
		if (rule.test(normalised)) {
			return { excluded: true, reason: rule.reason };
		}
	}
	return { excluded: false };
}

/**
 * Bulk filter — partitions paths into included and excluded with reasons.
 * Useful for the gulp task to log a summary of what got skipped.
 */
export function partitionPathsByExclusion(
	paths: ReadonlyArray<string>,
): {
	readonly included: readonly string[];
	readonly excluded: readonly { readonly path: string; readonly reason: I18nExclusionReason }[];
} {
	const included: string[] = [];
	const excluded: { path: string; reason: I18nExclusionReason }[] = [];
	for (const p of paths) {
		const v = decideI18nExclusion(p);
		if (v.excluded && v.reason) {
			excluded.push({ path: p, reason: v.reason });
		} else {
			included.push(p);
		}
	}
	return { included, excluded };
}

/**
 * Stable enumeration of all reasons for documentation / `vibe doctor`
 * output. Pure: returns a frozen list.
 */
export const I18N_EXCLUSION_REASONS: ReadonlyArray<I18nExclusionReason> = Object.freeze([
	'skill-prompt-template',
	'persona-template',
	'workflow-yaml',
	'react-out-bundle',
	'test-fixture',
	'snapshot-file',
	'build-artifact',
	'docs-only',
	'community-pack-content',
] as const);
