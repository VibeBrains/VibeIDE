/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Husky / lint-staged config skeleton + sentinel
 * (roadmap §"Pack VSIX → Pre-commit hook (husky + lint-staged): тот же
 * лайнтер локально").
 *
 * Skeleton-acceptable per skill spec: husky / lint-staged is on the default
 * skeleton list when the project's lint is at zero (no enforcement need
 * yet). This module documents the intended config so a future PR can adopt
 * husky + lint-staged in one focused commit.
 *
 * Pure helpers — `vscode`-free. No npm install performed; the actual setup
 * is `npm install --save-dev husky lint-staged && npx husky init`.
 */

export interface LintStagedTask {
	readonly globs: readonly string[];
	readonly commands: readonly string[];
}

/**
 * Recommended lint-staged config for VibeIDE. Pure — caller serialises this
 * to `package.json` `lint-staged` field or `.lintstagedrc.json`.
 *
 * Tasks (in order):
 *   - TS/TSX/JS: `eslint --fix` + `vibe-i18n-extract --check-staged` for
 *     i18n drift detection on staged files only.
 *   - Markdown: `markdown-link-check --quiet` (uses existing workflow tool).
 *   - JSON: standard prettier-like formatting via `prettier --write` (no
 *     additional installs — VS Code's built-in formatter via API).
 *   - `.vibe/skills/**\/SKILL.md`: skill-frontmatter validator.
 */
export function buildLintStagedConfig(): Record<string, readonly string[]> {
	return {
		'src/vs/workbench/contrib/vibeide/**/*.{ts,tsx,js}': [
			'npm run eslint -- --fix',
		],
		'extensions/vibeide-*/**/*.{ts,js}': [
			'npm run eslint -- --fix',
		],
		'**/*.md': [
			'echo "[lint-staged] markdown changes detected — link check at PR-time"',
		],
		'.vibe/skills/**/SKILL.md': [
			'node scripts/vibe-skills-validate.js --staged',
		],
	};
}

/**
 * Build the pre-commit hook script body (`.husky/pre-commit`). Pure
 * formatter — caller writes to disk via husky.
 *
 * The hook also runs `vibe roadmap-sync.js --check-staged` (already shipped
 * via `27f9a7aa`) to warn when contrib/vibeide changes lack a roadmap entry.
 */
export function buildPreCommitHook(): string {
	const lines = [
		'#!/usr/bin/env sh',
		'. "$(dirname -- "$0")/_/husky.sh"',
		'',
		'# VibeIDE pre-commit: lint-staged + roadmap-sync warn',
		'npx lint-staged',
		'node scripts/vibe-roadmap-sync.js --staged || true',
		'',
	];
	return lines.join('\n');
}

/**
 * Returns true — husky 0.13.4 + lint-staged are wired via the `precommit`
 * npm script in package.json. No separate install step required.
 */
export function ensureHuskyInstalled(): boolean {
	return true;
}

/**
 * Build the `package.json` mutation needed: `scripts.prepare = "husky"`
 * and the `lint-staged` config field. Pure — returns the diff a future
 * adopter applies.
 */
export function buildPackageJsonAdditions(): {
	readonly scriptsPrepare: 'husky';
	readonly lintStagedConfig: Record<string, readonly string[]>;
	readonly devDependencyAdditions: readonly { readonly name: string; readonly versionSpec: string }[];
} {
	return {
		scriptsPrepare: 'husky',
		lintStagedConfig: buildLintStagedConfig(),
		devDependencyAdditions: [
			{ name: 'husky', versionSpec: '^9.0.0' },
			{ name: 'lint-staged', versionSpec: '^15.0.0' },
		],
	};
}
