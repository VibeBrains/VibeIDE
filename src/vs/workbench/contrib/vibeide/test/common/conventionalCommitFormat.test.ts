/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	autoDetectScope,
	autoDetectType,
	formatConventionalCommit,
	parseConventionalCommit,
} from '../../common/conventionalCommitFormat.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('conventionalCommitFormat', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('formatConventionalCommit', () => {

		test('header only', () => {
			assert.strictEqual(
				formatConventionalCommit({ type: 'feat', subject: 'add caching layer' }),
				'feat: add caching layer',
			);
		});

		test('with scope', () => {
			assert.strictEqual(
				formatConventionalCommit({ type: 'fix', scope: 'auth', subject: 'handle expired token' }),
				'fix(auth): handle expired token',
			);
		});

		test('breaking change marker', () => {
			assert.strictEqual(
				formatConventionalCommit({ type: 'feat', scope: 'api', breaking: true, subject: 'rename endpoint' }),
				'feat(api)!: rename endpoint',
			);
		});

		test('with body', () => {
			const out = formatConventionalCommit({
				type: 'fix',
				subject: 'x',
				body: 'because Y\nand Z',
			});
			assert.match(out, /^fix: x\n\n/);
			assert.match(out, /because Y/);
		});

		test('with footers', () => {
			const out = formatConventionalCommit({
				type: 'feat',
				subject: 'x',
				footers: [{ key: 'Refs', value: '#123' }, { key: 'BREAKING CHANGE', value: 'API renamed' }],
			});
			assert.match(out, /Refs: #123/);
			assert.match(out, /BREAKING CHANGE: API renamed/);
		});

		test('subject longer than 72 chars is truncated with ellipsis', () => {
			const long = 'a'.repeat(100);
			const out = formatConventionalCommit({ type: 'chore', subject: long });
			const header = out.split('\n')[0];
			assert.ok(header.length <= 72 + 'chore: '.length, `header too long: ${header.length}`);
			assert.match(header, /…$/);
		});

		test('body wraps at 100 chars', () => {
			const body = 'word '.repeat(40).trim(); // 40 words ≈ 200 chars
			const out = formatConventionalCommit({ type: 'chore', subject: 'x', body });
			const bodyPart = out.split('\n\n')[1];
			for (const line of bodyPart.split('\n')) {
				assert.ok(line.length <= 100, `body line too long (${line.length}): ${line}`);
			}
		});
	});

	suite('parseConventionalCommit', () => {

		test('basic header', () => {
			const out = parseConventionalCommit('feat: add caching');
			assert.deepStrictEqual(out, { type: 'feat', scope: undefined, breaking: false, subject: 'add caching' });
		});

		test('with scope', () => {
			const out = parseConventionalCommit('fix(auth): handle expired token');
			assert.deepStrictEqual(out, { type: 'fix', scope: 'auth', breaking: false, subject: 'handle expired token' });
		});

		test('breaking change marker', () => {
			const out = parseConventionalCommit('feat(api)!: rename');
			assert.ok(out);
			assert.strictEqual(out.breaking, true);
		});

		test('returns null on malformed input', () => {
			assert.strictEqual(parseConventionalCommit(''), null);
			assert.strictEqual(parseConventionalCommit('not a commit'), null);
			assert.strictEqual(parseConventionalCommit('feat add foo'), null); // missing colon
			assert.strictEqual(parseConventionalCommit('FEAT: bad'), null); // type must be lowercase
			assert.strictEqual(parseConventionalCommit('unknown: bad'), null); // type not in vocab
		});

		test('round trip — format then parse', () => {
			const original = {
				type: 'feat' as const,
				scope: 'chat',
				breaking: true,
				subject: 'rewrite message pipeline',
				footers: [{ key: 'Refs', value: '#42' }],
			};
			const formatted = formatConventionalCommit(original);
			const parsed = parseConventionalCommit(formatted);
			assert.ok(parsed);
			assert.strictEqual(parsed.type, 'feat');
			assert.strictEqual(parsed.scope, 'chat');
			assert.strictEqual(parsed.breaking, true);
			assert.strictEqual(parsed.subject, 'rewrite message pipeline');
			assert.deepStrictEqual(parsed.footers, [{ key: 'Refs', value: '#42' }]);
		});

		test('header + body', () => {
			const raw = 'fix: x\n\nbecause Y\nand Z';
			const out = parseConventionalCommit(raw);
			assert.ok(out);
			assert.strictEqual(out.subject, 'x');
			assert.ok(out.body?.includes('because Y'));
		});
	});

	suite('autoDetectScope', () => {

		test('single contrib path → contrib name', () => {
			assert.strictEqual(
				autoDetectScope(['src/vs/workbench/contrib/vibeide/foo.ts']),
				'vibeide',
			);
		});

		test('multiple files in same contrib → that contrib', () => {
			assert.strictEqual(
				autoDetectScope([
					'src/vs/workbench/contrib/vibeide/a.ts',
					'src/vs/workbench/contrib/vibeide/b.ts',
				]),
				'vibeide',
			);
		});

		test('two contribs → undefined (ambiguous)', () => {
			assert.strictEqual(
				autoDetectScope([
					'src/vs/workbench/contrib/vibeide/a.ts',
					'src/vs/workbench/contrib/other/b.ts',
				]),
				undefined,
			);
		});

		test('extensions path', () => {
			assert.strictEqual(
				autoDetectScope(['extensions/git/src/api.ts']),
				'git',
			);
		});

		test('all-docs paths → docs umbrella', () => {
			assert.strictEqual(
				autoDetectScope(['docs/knowledge/foo.md', 'docs/roadmap.md']),
				'docs',
			);
		});

		test('scripts-only → scripts', () => {
			assert.strictEqual(
				autoDetectScope(['scripts/vibe-docs-graph.mjs']),
				'scripts',
			);
		});

		test('ci workflows → ci', () => {
			assert.strictEqual(
				autoDetectScope(['.github/workflows/pr.yml']),
				'ci',
			);
		});

		test('empty input → undefined', () => {
			assert.strictEqual(autoDetectScope([]), undefined);
		});

		test('Windows backslash paths normalized', () => {
			assert.strictEqual(
				autoDetectScope(['src\\vs\\workbench\\contrib\\vibeide\\foo.ts']),
				'vibeide',
			);
		});
	});

	suite('autoDetectType', () => {

		test('all-markdown paths → docs', () => {
			assert.strictEqual(
				autoDetectType('', ['README.md', 'docs/foo.md']),
				'docs',
			);
		});

		test('test files only → test', () => {
			assert.strictEqual(
				autoDetectType('', ['src/foo.test.ts', 'src/bar.spec.ts']),
				'test',
			);
		});

		test('CI workflow only → ci', () => {
			assert.strictEqual(
				autoDetectType('', ['.github/workflows/pr.yml']),
				'ci',
			);
		});

		test('build files only → build', () => {
			assert.strictEqual(
				autoDetectType('', ['package.json', 'tsconfig.json']),
				'build',
			);
		});

		test('diff with fix-words → fix', () => {
			assert.strictEqual(
				autoDetectType('+   // fix null pointer crash', ['src/foo.ts']),
				'fix',
			);
		});

		test('diff with feature-words → feat', () => {
			assert.strictEqual(
				autoDetectType('+ // implement new caching layer', ['src/foo.ts']),
				'feat',
			);
		});

		test('default → chore', () => {
			assert.strictEqual(
				autoDetectType('+ const x = 1', ['src/foo.ts']),
				'chore',
			);
		});
	});
});
