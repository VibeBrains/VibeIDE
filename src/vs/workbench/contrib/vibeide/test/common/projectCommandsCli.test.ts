/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decodeProjectCommandsCli,
	auditProjectCommandsForDoctor,
	repairProjectCommandsForDoctor,
	buildCliListJsonPayload,
} from '../../common/projectCommandsCli.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Project Commands — CLI argv decoder + doctor audit/repair', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeProjectCommandsCli', () => {
		test('empty argv → list (default)', () => {
			assert.deepStrictEqual(decodeProjectCommandsCli([]), { kind: 'list', json: false });
		});
		test('list', () => {
			assert.deepStrictEqual(decodeProjectCommandsCli(['list']), { kind: 'list', json: false });
		});
		test('list --json', () => {
			assert.deepStrictEqual(decodeProjectCommandsCli(['list', '--json']), { kind: 'list', json: true });
		});
		test('list with unknown flag → error', () => {
			const r = decodeProjectCommandsCli(['list', '--verbose']);
			assert.strictEqual(r.kind, 'error');
		});
		test('run id', () => {
			assert.deepStrictEqual(decodeProjectCommandsCli(['run', 'build-react']), { kind: 'run', id: 'build-react' });
		});
		test('run with no id', () => {
			const r = decodeProjectCommandsCli(['run']);
			assert.strictEqual(r.kind, 'error');
			if (r.kind === 'error') { assert.strictEqual(r.reason, 'run-needs-id'); }
		});
		test('run with invalid id pattern', () => {
			const r = decodeProjectCommandsCli(['run', 'BAD ID']);
			assert.strictEqual(r.kind, 'error');
			if (r.kind === 'error') { assert.strictEqual(r.reason, 'invalid-id'); }
		});
		test('run with extra args', () => {
			const r = decodeProjectCommandsCli(['run', 'br', 'extra']);
			assert.strictEqual(r.kind, 'error');
		});
		test('--help / -h / help', () => {
			assert.deepStrictEqual(decodeProjectCommandsCli(['--help']), { kind: 'help' });
			assert.deepStrictEqual(decodeProjectCommandsCli(['-h']), { kind: 'help' });
			assert.deepStrictEqual(decodeProjectCommandsCli(['help']), { kind: 'help' });
		});
		test('unknown subcommand', () => {
			const r = decodeProjectCommandsCli(['nonsense']);
			assert.strictEqual(r.kind, 'error');
			if (r.kind === 'error') { assert.strictEqual(r.reason, 'unknown-subcommand'); }
		});
	});

	suite('auditProjectCommandsForDoctor', () => {
		test('happy path → no issues', () => {
			const r = auditProjectCommandsForDoctor({
				vibeVersion: '1.0.0',
				commands: [{ id: 'a', name: 'A', command: 'echo' }],
			});
			assert.deepStrictEqual(r.issues, []);
			assert.ok(r.file);
		});

		test('decoder rejects → file-decode-failed', () => {
			const r = auditProjectCommandsForDoctor('not an object');
			assert.strictEqual(r.file, null);
			assert.strictEqual(r.issues.length, 1);
			assert.strictEqual(r.issues[0].code, 'file-decode-failed');
		});

		test('decoder rejects on duplicate id (file-decode-failed)', () => {
			const r = auditProjectCommandsForDoctor({
				vibeVersion: '1.0.0',
				commands: [
					{ id: 'a', name: 'A', command: 'echo' },
					{ id: 'a', name: 'A2', command: 'echo' },
				],
			});
			// Decoder catches duplicates as file-level reason
			assert.strictEqual(r.file, null);
			assert.strictEqual(r.issues[0].code, 'file-decode-failed');
		});

		test('decoder rejects on missing-command (file-decode-failed)', () => {
			const r = auditProjectCommandsForDoctor({
				vibeVersion: '1.0.0',
				commands: [{ id: 'a', name: 'A', command: '' }],
			});
			assert.strictEqual(r.file, null);
			assert.strictEqual(r.issues[0].code, 'file-decode-failed');
		});
	});

	suite('repairProjectCommandsForDoctor', () => {
		test('inserts missing vibeVersion', () => {
			const r = repairProjectCommandsForDoctor({ commands: [] }, '1.2.3');
			assert.strictEqual(r.repaired, true);
			assert.deepStrictEqual(r.nextRaw, { commands: [], vibeVersion: '1.2.3' });
			assert.ok(r.notes[0].includes('vibeVersion=1.2.3'));
		});

		test('does not overwrite existing vibeVersion', () => {
			const r = repairProjectCommandsForDoctor({ vibeVersion: '0.0.1', commands: [] }, '9.9.9');
			assert.strictEqual(r.repaired, false);
			assert.deepStrictEqual(r.nextRaw, { vibeVersion: '0.0.1', commands: [] });
		});

		test('non-object input → not repaired, manual fix note', () => {
			const r = repairProjectCommandsForDoctor('garbage', '1.0.0');
			assert.strictEqual(r.repaired, false);
			assert.ok(r.notes[0].includes('manual'));
		});

		test('does not mutate input', () => {
			const input = { commands: [] };
			repairProjectCommandsForDoctor(input, '1.0.0');
			assert.strictEqual(Object.hasOwn(input, 'vibeVersion'), false);
		});

		test('migrates legacy $id → id (single command)', () => {
			const r = repairProjectCommandsForDoctor({
				vibeVersion: '1.0.0',
				commands: [{ $id: 'build-react', name: 'Build', command: 'npm' }],
			}, '1.0.0');
			assert.strictEqual(r.repaired, true);
			const cmd = (r.nextRaw as { commands: Record<string, unknown>[] }).commands[0];
			assert.strictEqual(cmd.id, 'build-react');
			assert.strictEqual(Object.hasOwn(cmd, '$id'), false);
			assert.ok(r.notes.some(n => n.includes('migrated 1')));
		});

		test('migrates legacy $id → id (mixed)', () => {
			const r = repairProjectCommandsForDoctor({
				vibeVersion: '1.0.0',
				commands: [
					{ $id: 'one', name: 'One', command: 'echo' },
					{ id: 'two', name: 'Two', command: 'echo' },
					{ $id: 'three', name: 'Three', command: 'echo' },
				],
			}, '1.0.0');
			assert.strictEqual(r.repaired, true);
			const cmds = (r.nextRaw as { commands: Record<string, unknown>[] }).commands;
			assert.deepStrictEqual(cmds.map(c => c.id), ['one', 'two', 'three']);
			assert.ok(cmds.every(c => !Object.hasOwn(c, '$id')));
			assert.ok(r.notes.some(n => n.includes('migrated 2')));
		});

		test('drops $id when both $id and id present, keeps id', () => {
			const r = repairProjectCommandsForDoctor({
				vibeVersion: '1.0.0',
				commands: [{ $id: 'legacy', id: 'modern', name: 'X', command: 'x' }],
			}, '1.0.0');
			assert.strictEqual(r.repaired, true);
			const cmd = (r.nextRaw as { commands: Record<string, unknown>[] }).commands[0];
			assert.strictEqual(cmd.id, 'modern');
			assert.strictEqual(Object.hasOwn(cmd, '$id'), false);
		});
	});

	suite('auditProjectCommandsForDoctor — legacy $id', () => {
		test('reports legacy-dollar-id issue per command', () => {
			const result = auditProjectCommandsForDoctor({
				vibeVersion: '1.0.0',
				commands: [{ $id: 'legacy-cmd', name: 'X', command: 'x' }],
			});
			const codes = result.issues.map(i => i.code);
			assert.ok(codes.includes('legacy-dollar-id'));
			assert.strictEqual(result.file, null);
		});
	});

	suite('buildCliListJsonPayload', () => {
		test('null file → empty payload', () => {
			const p = buildCliListJsonPayload(null);
			assert.deepStrictEqual(p, { version: '0.0.0', count: 0, commands: [] });
		});

		test('payload omits env values for safety', () => {
			const p = buildCliListJsonPayload({
				vibeVersion: '1.0.0',
				commands: [{
					id: 'a',
					name: 'A',
					command: 'echo',
					env: { SECRET: 'super' },
					singleton: true,
					pinned: false,
				}],
			});
			assert.strictEqual(p.commands[0].id, 'a');
			assert.strictEqual(p.commands[0].singleton, true);
			assert.strictEqual(p.commands[0].pinned, false);
			assert.ok(!Object.hasOwn(p.commands[0], 'env'));
			assert.ok(!Object.hasOwn(p.commands[0], 'command'));
		});

		test('description forwarded only when present', () => {
			const p = buildCliListJsonPayload({
				vibeVersion: '1.0.0',
				commands: [
					{ id: 'a', name: 'A', command: 'echo', description: 'desc' },
					{ id: 'b', name: 'B', command: 'echo' },
				],
			});
			assert.strictEqual(p.commands[0].description, 'desc');
			assert.ok(!Object.hasOwn(p.commands[1], 'description'));
		});
	});
});
