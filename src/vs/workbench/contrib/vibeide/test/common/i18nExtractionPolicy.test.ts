/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decideI18nExclusion,
	partitionPathsByExclusion,
	I18N_EXCLUSION_REASONS,
} from '../../common/i18nExtractionPolicy.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('i18n extraction policy — path classifier', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideI18nExclusion', () => {
		test('skill SKILL.md → excluded:skill-prompt-template', () => {
			const r = decideI18nExclusion('.vibe/skills/example/SKILL.md');
			assert.strictEqual(r.excluded, true);
			assert.strictEqual(r.reason, 'skill-prompt-template');
		});

		test('skill prompt .vibe/prompts/foo.md → excluded', () => {
			const r = decideI18nExclusion('.vibe/prompts/build.md');
			assert.strictEqual(r.excluded, true);
			assert.strictEqual(r.reason, 'skill-prompt-template');
		});

		test('persona.md → excluded', () => {
			const r = decideI18nExclusion('.vibe/personas/coder/persona.md');
			assert.strictEqual(r.excluded, true);
			assert.strictEqual(r.reason, 'persona-template');
		});

		test('workflow yaml → excluded', () => {
			const r = decideI18nExclusion('.vibe/workflows/release.yaml');
			assert.strictEqual(r.excluded, true);
			assert.strictEqual(r.reason, 'workflow-yaml');
		});

		test('react out bundle → excluded', () => {
			const r = decideI18nExclusion('src/vs/workbench/contrib/vibeide/browser/react/out/sidebar-tsx/index.js');
			assert.strictEqual(r.excluded, true);
			assert.strictEqual(r.reason, 'react-out-bundle');
		});

		test('test fixture → excluded', () => {
			const r = decideI18nExclusion('src/vs/workbench/contrib/vibeide/test/common/foo.test.ts');
			assert.strictEqual(r.excluded, true);
			assert.strictEqual(r.reason, 'test-fixture');
		});

		test('snapshot file → excluded', () => {
			const r = decideI18nExclusion('src/__snapshots__/foo.snap');
			assert.strictEqual(r.excluded, true);
			assert.strictEqual(r.reason, 'snapshot-file');
		});

		test('build artifact → excluded', () => {
			assert.strictEqual(decideI18nExclusion('out/vs/foo.js').excluded, true);
			assert.strictEqual(decideI18nExclusion('.build/vsix/x.vsix').excluded, true);
			assert.strictEqual(decideI18nExclusion('node_modules/foo/index.js').excluded, true);
		});

		test('docs-only md → excluded', () => {
			assert.strictEqual(decideI18nExclusion('docs/v1/idea.md').excluded, true);
			assert.strictEqual(decideI18nExclusion('references/v1/agent.md').excluded, true);
		});

		test('Windows-style separators accepted', () => {
			const r = decideI18nExclusion('.vibe\\skills\\example\\SKILL.md');
			assert.strictEqual(r.excluded, true);
			assert.strictEqual(r.reason, 'skill-prompt-template');
		});

		test('regular contrib source NOT excluded', () => {
			const r = decideI18nExclusion('src/vs/workbench/contrib/vibeide/browser/vibeideChatPane.ts');
			assert.strictEqual(r.excluded, false);
		});

		test('extension package.json NOT excluded (UI metadata)', () => {
			const r = decideI18nExclusion('extensions/vibeide-neon/package.json');
			assert.strictEqual(r.excluded, false);
		});

		test('empty / non-string → not excluded', () => {
			assert.strictEqual(decideI18nExclusion('').excluded, false);
			assert.strictEqual(decideI18nExclusion(undefined as unknown as string).excluded, false);
		});

		test('leading slashes stripped before match', () => {
			const r = decideI18nExclusion('/.vibe/skills/x/SKILL.md');
			assert.strictEqual(r.excluded, true);
		});

		test('case-insensitive on rule patterns', () => {
			const r = decideI18nExclusion('.VIBE/skills/X/skill.md');
			assert.strictEqual(r.excluded, true);
		});

		test('community pack content → excluded', () => {
			const r = decideI18nExclusion('.vibe/skills/example/content.md');
			assert.strictEqual(r.excluded, true);
		});
	});

	suite('partitionPathsByExclusion', () => {
		test('mixed bag', () => {
			const r = partitionPathsByExclusion([
				'src/vs/workbench/contrib/vibeide/browser/x.ts',
				'.vibe/skills/example/SKILL.md',
				'src/vs/workbench/contrib/vibeide/test/common/x.test.ts',
				'src/vs/workbench/contrib/vibeide/common/y.ts',
			]);
			assert.strictEqual(r.included.length, 2);
			assert.strictEqual(r.excluded.length, 2);
			assert.deepStrictEqual(
				new Set(r.excluded.map(e => e.reason)),
				new Set(['skill-prompt-template', 'test-fixture']),
			);
		});

		test('empty input', () => {
			const r = partitionPathsByExclusion([]);
			assert.deepStrictEqual(r, { included: [], excluded: [] });
		});

		test('all excluded', () => {
			const r = partitionPathsByExclusion([
				'.vibe/skills/a/SKILL.md',
				'.vibe/skills/b/SKILL.md',
			]);
			assert.strictEqual(r.included.length, 0);
			assert.strictEqual(r.excluded.length, 2);
		});
	});

	test('I18N_EXCLUSION_REASONS frozen', () => {
		assert.strictEqual(I18N_EXCLUSION_REASONS.length, 9);
		assert.throws(() => {
			(I18N_EXCLUSION_REASONS as unknown as string[]).push('extra');
		});
	});
});
