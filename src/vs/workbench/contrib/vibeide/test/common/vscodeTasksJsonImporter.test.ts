/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	importTasksJson,
	makeUniqueId,
} from '../../common/vscodeTasksJsonImporter.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('VS Code tasks.json importer (317)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('importTasksJson', () => {
		test('non-object input → skipped <root>', () => {
			const r = importTasksJson(null);
			assert.strictEqual(r.imported.length, 0);
			assert.strictEqual(r.skipped[0].reason, 'not-an-object');
		});

		test('missing tasks array → skipped', () => {
			const r = importTasksJson({});
			assert.strictEqual(r.imported.length, 0);
			assert.strictEqual(r.skipped[0].reason, 'tasks-array-missing');
		});

		test('imports a basic shell task', () => {
			const r = importTasksJson({
				tasks: [
					{ label: 'Build', type: 'shell', command: 'npm', args: ['run', 'build'] },
				],
			});
			assert.strictEqual(r.imported.length, 1);
			const cmd = r.imported[0].command;
			assert.strictEqual(cmd.id, 'build');
			assert.strictEqual(cmd.name, 'Build');
			assert.strictEqual(cmd.command, 'npm');
			assert.deepStrictEqual(cmd.args, ['run', 'build']);
		});

		test('imports cwd / env from options', () => {
			const r = importTasksJson({
				tasks: [
					{
						label: 'Test',
						command: 'npm',
						args: ['test'],
						options: { cwd: 'src/lib', env: { NODE_ENV: 'test' } },
					},
				],
			});
			assert.strictEqual(r.imported[0].command.cwd, 'src/lib');
			assert.deepStrictEqual(r.imported[0].command.env, { NODE_ENV: 'test' });
		});

		test('skips tasks missing label or command', () => {
			const r = importTasksJson({
				tasks: [
					{ command: 'echo' }, // no label
					{ label: 'NoCmd' }, // no command
					{ label: 'OK', command: 'echo' },
				],
			});
			assert.strictEqual(r.imported.length, 1);
			assert.strictEqual(r.skipped.length, 2);
			assert.ok(r.skipped[0].reason === 'label-missing');
			assert.ok(r.skipped[1].reason === 'command-missing');
		});

		test('handles object-form args ({ value: "x" })', () => {
			const r = importTasksJson({
				tasks: [
					{ label: 'Cmd', command: 'foo', args: [{ value: 'one' }, 'two'] },
				],
			});
			assert.deepStrictEqual(r.imported[0].command.args, ['one', 'two']);
		});

		test('drops non-string env values', () => {
			const r = importTasksJson({
				tasks: [
					{ label: 'Cmd', command: 'foo', options: { env: { A: '1', B: 2 as unknown as string } } },
				],
			});
			assert.deepStrictEqual(r.imported[0].command.env, { A: '1' });
		});

		test('disambiguates duplicate labels by suffixing -N', () => {
			const r = importTasksJson({
				tasks: [
					{ label: 'Build', command: 'npm', args: ['run', 'build'] },
					{ label: 'Build', command: 'npm', args: ['run', 'build:prod'] },
					{ label: 'Build', command: 'npm', args: ['run', 'build:dev'] },
				],
			});
			const ids = r.imported.map(i => i.command.id);
			assert.deepStrictEqual(ids, ['build', 'build-1', 'build-2']);
		});

		test('skipped reason includes the task label', () => {
			const r = importTasksJson({
				tasks: [{ label: 'Bad', /* no command */ }],
			});
			assert.strictEqual(r.skipped[0].sourceLabel, 'Bad');
		});

		test('falls back to tasks[N] label when entry has no label', () => {
			const r = importTasksJson({
				tasks: [{ command: 'echo' }],
			});
			assert.strictEqual(r.skipped[0].sourceLabel, 'tasks[0]');
		});
	});

	suite('makeUniqueId', () => {
		test('lowercases and slugifies', () => {
			assert.strictEqual(makeUniqueId('My Test Label!!!', new Set()), 'my-test-label');
		});

		test('strips leading and trailing hyphens', () => {
			assert.strictEqual(makeUniqueId('---x---', new Set()), 'x');
		});

		test('disambiguates with -N suffix on collision', () => {
			const used = new Set(['x']);
			assert.strictEqual(makeUniqueId('x', used), 'x-1');
		});

		test('cap at 64 chars', () => {
			const long = 'a'.repeat(80);
			const id = makeUniqueId(long, new Set());
			assert.ok(id.length <= 60);
		});

		test('falls back to task when label is all special chars', () => {
			assert.strictEqual(makeUniqueId('!!!', new Set()), 'task');
		});
	});
});
