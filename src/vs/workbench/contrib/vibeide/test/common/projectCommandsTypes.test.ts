/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decodeProjectCommandsFile,
	sortProjectCommandsForDisplay,
	PROJECT_COMMAND_ID_PATTERN,
	ProjectCommand,
	ProjectCommandsNotImplementedError,
} from '../../common/projectCommandsTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Project Commands — pure types and decoder', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('PROJECT_COMMAND_ID_PATTERN', () => {
		test('accepts lowercase + digits + hyphens', () => {
			assert.ok(PROJECT_COMMAND_ID_PATTERN.test('build-react'));
			assert.ok(PROJECT_COMMAND_ID_PATTERN.test('a'));
			assert.ok(PROJECT_COMMAND_ID_PATTERN.test('cmd-1'));
		});

		test('rejects uppercase / spaces / underscores', () => {
			assert.ok(!PROJECT_COMMAND_ID_PATTERN.test('Build'));
			assert.ok(!PROJECT_COMMAND_ID_PATTERN.test('build react'));
			assert.ok(!PROJECT_COMMAND_ID_PATTERN.test('build_react'));
		});

		test('rejects starting with hyphen', () => {
			assert.ok(!PROJECT_COMMAND_ID_PATTERN.test('-foo'));
		});

		test('rejects too long', () => {
			assert.ok(!PROJECT_COMMAND_ID_PATTERN.test('a'.repeat(65)));
		});
	});

	suite('decodeProjectCommandsFile — happy path', () => {
		test('minimal valid file', () => {
			const r = decodeProjectCommandsFile({
				vibeVersion: '0.1.0',
				commands: [{ id: 'build', name: 'Build', command: 'npm run build' }],
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.commands.length, 1);
				assert.strictEqual(r.value.commands[0].id, 'build');
				assert.strictEqual(r.value.commands[0].name, 'Build');
			}
		});

		test('decodes optional fields', () => {
			const r = decodeProjectCommandsFile({
				vibeVersion: '0.1.0',
				commands: [{
					id: 'rebuild-react',
					name: 'Rebuild React',
					command: 'npm',
					args: ['run', 'buildreact'],
					cwd: 'src/vs/workbench/contrib/vibeide/browser/react',
					env: { NODE_ENV: 'development' },
					terminal: 'integrated',
					shell: false,
					confirm: true,
					singleton: true,
					pinned: true,
					order: 10,
					workflowId: 'react-rebuild',
					description: 'Compile React bundles',
					icon: 'rocket',
					color: 'var(--vibe-accent)',
				}],
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				const cmd = r.value.commands[0];
				assert.deepStrictEqual(cmd.args, ['run', 'buildreact']);
				assert.strictEqual(cmd.cwd, 'src/vs/workbench/contrib/vibeide/browser/react');
				assert.deepStrictEqual(cmd.env, { NODE_ENV: 'development' });
				assert.strictEqual(cmd.singleton, true);
				assert.strictEqual(cmd.pinned, true);
				assert.strictEqual(cmd.order, 10);
				assert.strictEqual(cmd.workflowId, 'react-rebuild');
			}
		});

		test('empty commands array is valid', () => {
			const r = decodeProjectCommandsFile({ vibeVersion: '0.1.0', commands: [] });
			assert.strictEqual(r.ok, true);
		});
	});

	suite('decodeProjectCommandsFile — rejection paths', () => {
		test('rejects non-object', () => {
			assert.deepStrictEqual(decodeProjectCommandsFile(null), { ok: false, reason: 'not-an-object' });
			assert.deepStrictEqual(decodeProjectCommandsFile('foo'), { ok: false, reason: 'not-an-object' });
		});

		test('rejects missing vibeVersion', () => {
			const r = decodeProjectCommandsFile({ commands: [] });
			assert.deepStrictEqual(r, { ok: false, reason: 'vibeVersion-missing' });
		});

		test('rejects non-array commands', () => {
			const r = decodeProjectCommandsFile({ vibeVersion: '0.1.0', commands: {} });
			assert.deepStrictEqual(r, { ok: false, reason: 'commands-not-array' });
		});

		test('rejects invalid id', () => {
			const r = decodeProjectCommandsFile({
				vibeVersion: '0.1.0',
				commands: [{ id: 'Build', name: 'x', command: 'echo' }],
			});
			assert.deepStrictEqual(r, { ok: false, reason: 'commands[0]:id-invalid' });
		});

		test('rejects duplicate id', () => {
			const r = decodeProjectCommandsFile({
				vibeVersion: '0.1.0',
				commands: [
					{ id: 'a', name: '1', command: 'x' },
					{ id: 'a', name: '2', command: 'y' },
				],
			});
			assert.deepStrictEqual(r, { ok: false, reason: 'commands[1]:duplicate-id:a' });
		});

		test('rejects bad terminal value', () => {
			const r = decodeProjectCommandsFile({
				vibeVersion: '0.1.0',
				commands: [{ id: 'a', name: 'x', command: 'echo', terminal: 'pty' }],
			});
			assert.deepStrictEqual(r, { ok: false, reason: 'commands[0]:terminal-invalid' });
		});

		test('rejects non-string env value', () => {
			const r = decodeProjectCommandsFile({
				vibeVersion: '0.1.0',
				commands: [{ id: 'a', name: 'x', command: 'echo', env: { N: 5 } }],
			});
			assert.deepStrictEqual(r, { ok: false, reason: 'commands[0]:env.N-not-string' });
		});

		test('rejects non-string element in args', () => {
			const r = decodeProjectCommandsFile({
				vibeVersion: '0.1.0',
				commands: [{ id: 'a', name: 'x', command: 'echo', args: ['ok', 5] }],
			});
			assert.deepStrictEqual(r, { ok: false, reason: 'commands[0]:args-invalid' });
		});
	});

	suite('sortProjectCommandsForDisplay', () => {
		const cmd = (id: string, name: string, order?: number): ProjectCommand => ({
			id, name, command: 'echo', order,
		});

		test('orders by `order` ascending', () => {
			const out = sortProjectCommandsForDisplay([
				cmd('a', 'A', 5),
				cmd('b', 'B', 1),
				cmd('c', 'C', 10),
			]);
			assert.deepStrictEqual(out.map(c => c.id), ['b', 'a', 'c']);
		});

		test('falls back to name for tie-break', () => {
			const out = sortProjectCommandsForDisplay([
				cmd('a', 'Zebra', 1),
				cmd('b', 'Alpha', 1),
			]);
			assert.deepStrictEqual(out.map(c => c.id), ['b', 'a']);
		});

		test('commands without order go to the end', () => {
			const out = sortProjectCommandsForDisplay([
				cmd('a', 'A'),
				cmd('b', 'B', 5),
			]);
			assert.deepStrictEqual(out.map(c => c.id), ['b', 'a']);
		});
	});

	suite('ProjectCommandsNotImplementedError', () => {
		test('carries operation name and stable type', () => {
			const e = new ProjectCommandsNotImplementedError('run');
			assert.strictEqual(e.name, 'ProjectCommandsNotImplementedError');
			assert.match(e.message, /operation: run/);
		});
	});
});
