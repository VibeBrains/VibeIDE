/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	diffCommandsForImport,
	renderImportDiffMarkdown,
	shortCommand,
	ProjectCommandLite,
} from '../../common/commandsImportDiff.js';

const cmd = (overrides: Partial<ProjectCommandLite> = {}): ProjectCommandLite => ({
	id: 'build',
	name: 'Build',
	command: 'npm',
	args: ['run', 'build'],
	...overrides,
});

suite('commandsImportDiff', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('diffCommandsForImport', () => {
		test('all-new incoming → all "added"', () => {
			const r = diffCommandsForImport([], [cmd({ id: 'a' }), cmd({ id: 'b' })]);
			assert.strictEqual(r.stats.added, 2);
			assert.strictEqual(r.stats.modified, 0);
			assert.strictEqual(r.stats.removed, 0);
			assert.strictEqual(r.touchesSensitiveFields, true);  // new command introduces command field
		});

		test('all-removed → "removed" entries with no after', () => {
			const r = diffCommandsForImport([cmd({ id: 'a' })], []);
			assert.strictEqual(r.stats.removed, 1);
			assert.strictEqual(r.items[0].kind, 'removed');
			assert.strictEqual(r.items[0].after, undefined);
		});

		test('identical → all "unchanged" + touchesSensitiveFields false', () => {
			const same = cmd({ id: 'a' });
			const r = diffCommandsForImport([same], [same]);
			assert.strictEqual(r.stats.unchanged, 1);
			assert.strictEqual(r.touchesSensitiveFields, false);
		});

		test('modified command → "modified" with changedFields=[command] and sensitive flag', () => {
			const r = diffCommandsForImport(
				[cmd({ id: 'a', command: 'old' })],
				[cmd({ id: 'a', command: 'new' })],
			);
			assert.strictEqual(r.stats.modified, 1);
			assert.deepStrictEqual(r.items[0].changedFields, ['command']);
			assert.strictEqual(r.touchesSensitiveFields, true);
		});

		test('modified args order matters', () => {
			const r = diffCommandsForImport(
				[cmd({ id: 'a', args: ['a', 'b'] })],
				[cmd({ id: 'a', args: ['b', 'a'] })],
			);
			assert.strictEqual(r.stats.modified, 1);
			assert.ok(r.items[0].changedFields.includes('args'));
		});

		test('modified env value flagged', () => {
			const r = diffCommandsForImport(
				[cmd({ id: 'a', env: { TOKEN: 'old' } })],
				[cmd({ id: 'a', env: { TOKEN: 'new' } })],
			);
			assert.ok(r.items[0].changedFields.includes('env'));
			assert.strictEqual(r.touchesSensitiveFields, true);
		});

		test('modified env keys flagged (added key)', () => {
			const r = diffCommandsForImport(
				[cmd({ id: 'a', env: {} })],
				[cmd({ id: 'a', env: { TOKEN: 'x' } })],
			);
			assert.ok(r.items[0].changedFields.includes('env'));
		});

		test('modified cwd flagged as sensitive', () => {
			const r = diffCommandsForImport(
				[cmd({ id: 'a', cwd: '/old' })],
				[cmd({ id: 'a', cwd: '/new' })],
			);
			assert.ok(r.items[0].changedFields.includes('cwd'));
			assert.strictEqual(r.touchesSensitiveFields, true);
		});

		test('modified name only — touchesSensitiveFields stays false', () => {
			const r = diffCommandsForImport(
				[cmd({ id: 'a', name: 'old' })],
				[cmd({ id: 'a', name: 'new' })],
			);
			assert.deepStrictEqual(r.items[0].changedFields, ['name']);
			assert.strictEqual(r.touchesSensitiveFields, false);
		});

		test('mixed batch: added + modified + removed + unchanged', () => {
			const r = diffCommandsForImport(
				[
					cmd({ id: 'keep' }),
					cmd({ id: 'edit', command: 'old' }),
					cmd({ id: 'gone' }),
				],
				[
					cmd({ id: 'keep' }),
					cmd({ id: 'edit', command: 'new' }),
					cmd({ id: 'fresh' }),
				],
			);
			assert.strictEqual(r.stats.added, 1);
			assert.strictEqual(r.stats.modified, 1);
			assert.strictEqual(r.stats.removed, 1);
			assert.strictEqual(r.stats.unchanged, 1);
		});

		test('order: incoming order first, removed last', () => {
			const r = diffCommandsForImport(
				[cmd({ id: 'old1' }), cmd({ id: 'old2' })],
				[cmd({ id: 'new1' }), cmd({ id: 'new2' })],
			);
			const ids = r.items.map(i => i.id);
			assert.deepStrictEqual(ids, ['new1', 'new2', 'old1', 'old2']);
		});

		test('absent args === [] for comparison', () => {
			const r = diffCommandsForImport(
				[cmd({ id: 'a', args: undefined })],
				[cmd({ id: 'a', args: [] })],
			);
			assert.strictEqual(r.stats.unchanged, 1);
		});

		test('absent env === {} for comparison', () => {
			const r = diffCommandsForImport(
				[cmd({ id: 'a', env: undefined })],
				[cmd({ id: 'a', env: {} })],
			);
			assert.strictEqual(r.stats.unchanged, 1);
		});
	});

	suite('renderImportDiffMarkdown', () => {
		test('shows stats line', () => {
			const diff = diffCommandsForImport(
				[cmd({ id: 'a' })],
				[cmd({ id: 'a', command: 'new' })],
			);
			const md = renderImportDiffMarkdown(diff);
			assert.match(md, /добавлено 0, изменено 1, удалено 0/);
		});

		test('warning banner shown when sensitive fields touched', () => {
			const diff = diffCommandsForImport(
				[cmd({ id: 'a', command: 'old' })],
				[cmd({ id: 'a', command: 'new' })],
			);
			assert.match(renderImportDiffMarkdown(diff), /SHA-256 проверки недостаточно/);
		});

		test('no warning banner for name-only change', () => {
			const diff = diffCommandsForImport(
				[cmd({ id: 'a', name: 'old' })],
				[cmd({ id: 'a', name: 'new' })],
			);
			assert.ok(!renderImportDiffMarkdown(diff).includes('SHA-256'));
		});

		test('sensitive field markers prefixed with [!]', () => {
			const diff = diffCommandsForImport(
				[cmd({ id: 'a', command: 'old', name: 'old' })],
				[cmd({ id: 'a', command: 'new', name: 'new' })],
			);
			const md = renderImportDiffMarkdown(diff);
			assert.match(md, /\[!\]command/);
			assert.ok(!md.includes('[!]name'));
		});

		test('added rendered with `+`, removed with `−`, modified with `~`, unchanged with `=`', () => {
			const diff = diffCommandsForImport(
				[cmd({ id: 'keep' }), cmd({ id: 'gone' })],
				[cmd({ id: 'keep' }), cmd({ id: 'fresh' })],
			);
			const md = renderImportDiffMarkdown(diff);
			assert.match(md, /\+ \*\*fresh\*\*/);
			assert.match(md, /− \*\*gone\*\*/);
			assert.match(md, /= keep/);
		});
	});

	suite('shortCommand', () => {
		test('short command pass-through with args joined', () => {
			assert.strictEqual(shortCommand(cmd()), 'npm run build');
		});

		test('long command truncated to 60 with ellipsis', () => {
			const long = cmd({ command: 'a'.repeat(100), args: undefined });
			const r = shortCommand(long);
			assert.ok(r.length <= 60);
			assert.ok(r.endsWith('…'));
		});

		test('no args → no trailing space', () => {
			assert.strictEqual(shortCommand(cmd({ args: undefined })), 'npm');
		});

		test('empty args → no trailing space', () => {
			assert.strictEqual(shortCommand(cmd({ args: [] })), 'npm');
		});
	});
});
