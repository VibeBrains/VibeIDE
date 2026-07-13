/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseScope, upsertFrontmatterField } from '../../browser/vibeSpecsService.js';

suite('vibeSpecsService frontmatter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseScope', () => {
		test('inline, block, quotes, and absence', () => {
			assert.deepStrictEqual(
				[
					parseScope('status: approved\nscope: [src/a/**, "src/b.ts"]'),
					parseScope('scope:\n  - src/a/**\n  - "src/b.ts"\nstatus: draft'),
					parseScope('status: draft'),
					parseScope('scope: []'),
				],
				[
					['src/a/**', 'src/b.ts'],
					['src/a/**', 'src/b.ts'],
					undefined,
					undefined,
				],
			);
		});
	});

	suite('upsertFrontmatterField', () => {
		test('replaces an existing key in place', () => {
			const out = upsertFrontmatterField('---\nstatus: draft\nboundThreadId: old\n---\n# Spec\n', 'boundThreadId', 'new');
			assert.strictEqual(out, '---\nstatus: draft\nboundThreadId: new\n---\n# Spec\n');
		});

		test('appends a missing key inside an existing block', () => {
			const out = upsertFrontmatterField('---\nstatus: approved\n---\n# Spec\n', 'boundThreadId', 't1');
			assert.strictEqual(out, '---\nstatus: approved\nboundThreadId: t1\n---\n# Spec\n');
		});

		test('creates a frontmatter block when none exists', () => {
			const out = upsertFrontmatterField('# Spec\nbody\n', 'boundThreadId', 't1');
			assert.strictEqual(out, '---\nboundThreadId: t1\n---\n# Spec\nbody\n');
		});
	});
});
