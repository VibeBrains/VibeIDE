/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	buildLintStagedConfig,
	buildPreCommitHook,
	buildPackageJsonAdditions,
	ensureHuskyInstalled,
} from '../../common/huskyLintStagedSkeleton.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Husky / lint-staged config skeleton + sentinel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildLintStagedConfig', () => {
		test('returns config with vibeide TS glob', () => {
			const c = buildLintStagedConfig();
			assert.ok(Object.hasOwn(c, 'src/vs/workbench/contrib/vibeide/**/*.{ts,tsx,js}'));
		});

		test('vibeide TS glob runs eslint --fix', () => {
			const c = buildLintStagedConfig();
			const cmds = c['src/vs/workbench/contrib/vibeide/**/*.{ts,tsx,js}'];
			assert.ok(cmds.some(cmd => cmd.includes('eslint')));
		});

		test('extensions glob included', () => {
			const c = buildLintStagedConfig();
			assert.ok(Object.hasOwn(c, 'extensions/vibeide-*/**/*.{ts,js}'));
		});

		test('skill SKILL.md glob included for validator', () => {
			const c = buildLintStagedConfig();
			assert.ok(Object.hasOwn(c, '.vibe/skills/**/SKILL.md'));
			const cmds = c['.vibe/skills/**/SKILL.md'];
			assert.ok(cmds.some(cmd => cmd.includes('vibe-skills-validate')));
		});
	});

	suite('buildPreCommitHook', () => {
		test('generates sh-shebang', () => {
			const hook = buildPreCommitHook();
			assert.ok(hook.startsWith('#!/usr/bin/env sh'));
		});

		test('sources husky helper', () => {
			const hook = buildPreCommitHook();
			assert.ok(hook.includes('husky.sh'));
		});

		test('runs lint-staged', () => {
			const hook = buildPreCommitHook();
			assert.ok(hook.includes('npx lint-staged'));
		});

		test('runs roadmap-sync warn (existing 27f9a7aa)', () => {
			const hook = buildPreCommitHook();
			assert.ok(hook.includes('vibe-roadmap-sync.js'));
			assert.ok(hook.includes('|| true'), 'warn-only — must not fail commit');
		});
	});

	suite('buildPackageJsonAdditions', () => {
		test('scripts.prepare = "husky"', () => {
			const a = buildPackageJsonAdditions();
			assert.strictEqual(a.scriptsPrepare, 'husky');
		});

		test('devDependencies include husky + lint-staged', () => {
			const a = buildPackageJsonAdditions();
			const names = a.devDependencyAdditions.map(d => d.name);
			assert.ok(names.includes('husky'));
			assert.ok(names.includes('lint-staged'));
		});

		test('versions are caret-pinned (allow patch updates)', () => {
			const a = buildPackageJsonAdditions();
			for (const d of a.devDependencyAdditions) {
				assert.ok(d.versionSpec.startsWith('^'), `${d.name} should be caret-pinned`);
			}
		});

		test('lintStagedConfig matches buildLintStagedConfig', () => {
			const a = buildPackageJsonAdditions();
			const c = buildLintStagedConfig();
			assert.deepStrictEqual(a.lintStagedConfig, c);
		});
	});

	suite('ensureHuskyInstalled', () => {
		test('reports husky wired (returns true)', () => {
			assert.strictEqual(ensureHuskyInstalled(), true);
		});
	});
});
