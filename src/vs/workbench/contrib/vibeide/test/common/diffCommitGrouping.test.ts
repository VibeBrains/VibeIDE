/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	groupDiffByCommitType,
	renderGroupStub,
	DiffFileChange,
} from '../../common/diffCommitGrouping.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const f = (path: string, extra: Partial<DiffFileChange> = {}): DiffFileChange => ({ path, ...extra });

suite('Diff commit grouping (932)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('groupDiffByCommitType', () => {
		test('empty input → empty groups', () => {
			assert.deepStrictEqual(groupDiffByCommitType([]), []);
		});

		test('CI workflow files → ci(workflows)', () => {
			const r = groupDiffByCommitType([
				f('.github/workflows/test-coverage.yml'),
				f('.github/workflows/privacy-verify.yml'),
			]);
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].type, 'ci');
			assert.strictEqual(r[0].scope, 'workflows');
			assert.strictEqual(r[0].files.length, 2);
		});

		test('package.json + lockfile → build(deps)', () => {
			const r = groupDiffByCommitType([f('package.json'), f('package-lock.json')]);
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].type, 'build');
			assert.strictEqual(r[0].scope, 'deps');
		});

		test('markdown files → docs (no scope)', () => {
			const r = groupDiffByCommitType([f('README.md'), f('docs/idea.md')]);
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].type, 'docs');
			assert.strictEqual(r[0].scope, undefined);
		});

		test('test files → test (no scope)', () => {
			const r = groupDiffByCommitType([f('src/foo.test.ts'), f('test/util.ts')]);
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].type, 'test');
		});

		test('CSS files → style', () => {
			const r = groupDiffByCommitType([f('src/style.css'), f('src/theme.scss')]);
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].type, 'style');
		});

		test('src/<scope>/ → feat(scope)', () => {
			const r = groupDiffByCommitType([
				f('src/vs/main.ts'),
				f('src/vs/workbench/contrib/foo.ts'),
			]);
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].type, 'feat');
			assert.strictEqual(r[0].scope, 'vs');
		});

		test('mixed input produces multiple groups in first-seen order', () => {
			const r = groupDiffByCommitType([
				f('src/foo.test.ts'),       // test
				f('docs/README.md'),         // docs
				f('src/vs/main.ts'),         // feat(vs)
				f('package.json'),           // build(deps)
			]);
			assert.deepStrictEqual(r.map(g => `${g.type}${g.scope ? `(${g.scope})` : ''}`),
				['test', 'docs', 'feat(vs)', 'build(deps)']);
		});

		test('skips empty paths', () => {
			const r = groupDiffByCommitType([f(''), f('docs/x.md')]);
			assert.strictEqual(r.length, 1);
			assert.strictEqual(r[0].files.length, 1);
		});

		test('Windows separators normalised', () => {
			const r = groupDiffByCommitType([f('src\\vs\\foo.ts')]);
			assert.strictEqual(r[0].scope, 'vs');
		});

		test('priority: CI before docs (a workflow yaml is not docs)', () => {
			const r = groupDiffByCommitType([f('.github/workflows/foo.yml')]);
			assert.strictEqual(r[0].type, 'ci');
		});

		test('priority: lockfile before docs (package.json is build, not docs)', () => {
			const r = groupDiffByCommitType([f('package.json')]);
			assert.strictEqual(r[0].type, 'build');
		});

		test('top-level non-src directory becomes feat(<top>)', () => {
			const r = groupDiffByCommitType([f('extensions/vibeide-neon/index.ts')]);
			assert.strictEqual(r[0].type, 'feat');
			assert.strictEqual(r[0].scope, 'extensions');
		});
	});

	suite('renderGroupStub', () => {
		test('all-new files → "add N files"', () => {
			const stub = renderGroupStub({
				type: 'feat',
				scope: 'workbench',
				files: [f('a.ts', { isNew: true }), f('b.ts', { isNew: true })],
			});
			assert.strictEqual(stub, 'feat(workbench): add 2 files');
		});

		test('all-deleted → "remove"', () => {
			const stub = renderGroupStub({
				type: 'chore',
				files: [f('legacy.ts', { isDeleted: true })],
			});
			assert.strictEqual(stub, 'chore: remove 1 file');
		});

		test('mixed → "edit"', () => {
			const stub = renderGroupStub({
				type: 'feat',
				files: [f('a.ts'), f('b.ts', { isNew: true })],
			});
			assert.strictEqual(stub, 'feat: edit 2 files');
		});

		test('omits scope when undefined', () => {
			const stub = renderGroupStub({ type: 'docs', files: [f('README.md')] });
			assert.strictEqual(stub, 'docs: edit 1 file');
		});
	});
});
