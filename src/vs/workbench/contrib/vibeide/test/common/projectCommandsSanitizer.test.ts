/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	sanitizeProjectCommand,
	checkCwdWithinWorkspace,
	checkCwdTraversal,
	describeIssue,
} from '../../common/projectCommandsSanitizer.js';
import { ProjectCommand } from '../../common/projectCommandsTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const cmd = (overrides: Partial<ProjectCommand>): ProjectCommand => ({
	id: 'build',
	name: 'Build',
	command: 'npm',
	...overrides,
});

suite('Project Commands sanitizer (335 / 336)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('sanitizeProjectCommand', () => {
		test('clean command + safe args → ok', () => {
			const r = sanitizeProjectCommand(cmd({ args: ['run', 'build'] }));
			assert.deepStrictEqual(r, { ok: true, issues: [] });
		});

		test('zero-width char in command rejected', () => {
			const r = sanitizeProjectCommand(cmd({ command: 'np​m' }));
			assert.strictEqual(r.ok, false);
			assert.strictEqual(r.issues[0].kind, 'zero-width-char');
		});

		test('Bidi override in args rejected', () => {
			const r = sanitizeProjectCommand(cmd({ args: ['run', 'bu‮ild'] }));
			assert.strictEqual(r.ok, false);
			assert.ok(r.issues.some(i => i.kind === 'bidi-override' && i.field === 'args'));
		});

		test('control char (CR) in command rejected', () => {
			const r = sanitizeProjectCommand(cmd({ command: 'npm\rrun' }));
			assert.strictEqual(r.ok, false);
			assert.ok(r.issues.some(i => i.kind === 'control-char'));
		});

		test('shell metachar in args without shell:true → flagged', () => {
			const r = sanitizeProjectCommand(cmd({ args: ['run', 'build && malicious'] }));
			assert.strictEqual(r.ok, false);
			assert.ok(r.issues.some(i => i.kind === 'shell-metachar'));
		});

		test('shell metachar allowed when shell:true', () => {
			const r = sanitizeProjectCommand(cmd({ shell: true, args: ['run', 'build && other'] }));
			assert.strictEqual(r.ok, true);
		});

		test('multiple issues all reported', () => {
			const r = sanitizeProjectCommand(cmd({
				command: 'np​m',
				args: ['x; rm -rf /'],
			}));
			assert.strictEqual(r.ok, false);
			assert.ok(r.issues.length >= 2);
		});
	});

	suite('checkCwdWithinWorkspace', () => {
		test('cwd === root → ok', () => {
			assert.strictEqual(checkCwdWithinWorkspace('/ws', '/ws'), null);
		});

		test('cwd inside root → ok', () => {
			assert.strictEqual(checkCwdWithinWorkspace('/ws/sub/dir', '/ws'), null);
		});

		test('cwd outside root rejected', () => {
			const r = checkCwdWithinWorkspace('/elsewhere', '/ws');
			assert.strictEqual(r?.kind, 'cwd-outside-workspace');
		});

		test('prefix-but-not-subpath rejected (/wsX vs /ws)', () => {
			const r = checkCwdWithinWorkspace('/ws-other/sub', '/ws');
			assert.strictEqual(r?.kind, 'cwd-outside-workspace');
		});

		test('Windows separators normalised', () => {
			assert.strictEqual(checkCwdWithinWorkspace('C:\\ws\\sub', 'C:\\ws'), null);
		});

		test('trailing slashes stripped', () => {
			assert.strictEqual(checkCwdWithinWorkspace('/ws/', '/ws'), null);
		});

		test('non-string input rejected', () => {
			const r = checkCwdWithinWorkspace(undefined as unknown as string, '/ws');
			assert.strictEqual(r?.kind, 'cwd-outside-workspace');
		});
	});

	suite('checkCwdTraversal', () => {
		test('clean relative path → ok', () => {
			assert.strictEqual(checkCwdTraversal('packages/x'), null);
		});

		test('detects .. segment', () => {
			const r = checkCwdTraversal('../etc');
			assert.strictEqual(r?.kind, 'cwd-traversal');
		});

		test('detects nested .. segment', () => {
			const r = checkCwdTraversal('packages/../../etc');
			assert.strictEqual(r?.kind, 'cwd-traversal');
		});

		test('Windows separators counted', () => {
			const r = checkCwdTraversal('packages\\..\\etc');
			assert.strictEqual(r?.kind, 'cwd-traversal');
		});

		test('non-string input flagged', () => {
			const r = checkCwdTraversal(null as unknown as string);
			assert.strictEqual(r?.kind, 'cwd-traversal');
		});
	});

	suite('describeIssue', () => {
		test('produces human-readable message for each issue kind', () => {
			const samples = [
				describeIssue({ kind: 'zero-width-char', field: 'command' }),
				describeIssue({ kind: 'bidi-override', field: 'args' }),
				describeIssue({ kind: 'control-char', field: 'command' }),
				describeIssue({ kind: 'shell-metachar', field: 'args', arg: '&&' }),
				describeIssue({ kind: 'cwd-outside-workspace', resolvedCwd: '/elsewhere' }),
				describeIssue({ kind: 'cwd-traversal', cwdInput: '../etc' }),
			];
			for (const text of samples) {
				assert.ok(typeof text === 'string' && text.length > 0);
			}
		});
	});
});
