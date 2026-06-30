/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decodeProjectCommandsGlobalPaths,
	looksLikeAbsolutePath,
	mergeProjectCommandsByPriority,
} from '../../common/projectCommandsGlobalPaths.js';
import { ProjectCommand } from '../../common/projectCommandsTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function cmd(id: string, name = id): ProjectCommand {
	return { id, name, command: 'echo' };
}

suite('Project Commands — globalPaths decoder + workspace-wins merge', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeProjectCommandsGlobalPaths', () => {
		test('undefined / null → empty', () => {
			assert.deepStrictEqual(decodeProjectCommandsGlobalPaths(undefined), { entries: [], skipped: [] });
			assert.deepStrictEqual(decodeProjectCommandsGlobalPaths(null), { entries: [], skipped: [] });
		});

		test('non-array → flagged once, no entries', () => {
			const r = decodeProjectCommandsGlobalPaths('C:/oops');
			assert.deepStrictEqual(r.entries, []);
			assert.strictEqual(r.skipped.length, 1);
			assert.strictEqual(r.skipped[0].reason, 'not-string');
		});

		test('valid absolute paths pass through trimmed', () => {
			const r = decodeProjectCommandsGlobalPaths(['  C:/Users/me/.vibe  ', '/home/me/.vibe']);
			assert.deepStrictEqual(r.entries, ['C:/Users/me/.vibe', '/home/me/.vibe']);
			assert.strictEqual(r.skipped.length, 0);
		});

		test('drops non-string / empty / whitespace-only', () => {
			const r = decodeProjectCommandsGlobalPaths(['/ok', 42, '', '   ', null, '/ok']);
			assert.deepStrictEqual(r.entries, ['/ok']);
			assert.strictEqual(r.skipped.length, 5);
			const reasons = r.skipped.map(s => s.reason).sort();
			assert.deepStrictEqual(reasons, ['duplicate', 'empty', 'empty', 'not-string', 'not-string']);
		});

		test('preserves first-seen for duplicates after trim', () => {
			const r = decodeProjectCommandsGlobalPaths(['/a', ' /a ', '/b']);
			assert.deepStrictEqual(r.entries, ['/a', '/b']);
			assert.strictEqual(r.skipped.length, 1);
			assert.strictEqual(r.skipped[0].reason, 'duplicate');
		});
	});

	suite('looksLikeAbsolutePath', () => {
		test('Windows drive', () => {
			assert.ok(looksLikeAbsolutePath('C:/x'));
			assert.ok(looksLikeAbsolutePath('D:\\x'));
		});
		test('POSIX root', () => {
			assert.ok(looksLikeAbsolutePath('/etc'));
		});
		test('home tilde', () => {
			assert.ok(looksLikeAbsolutePath('~/x'));
			assert.ok(looksLikeAbsolutePath('~\\x'));
		});
		test('rejects relative', () => {
			assert.ok(!looksLikeAbsolutePath('relative/path'));
			assert.ok(!looksLikeAbsolutePath('./x'));
			assert.ok(!looksLikeAbsolutePath('../x'));
		});
	});

	suite('mergeProjectCommandsByPriority', () => {
		test('disjoint sets merge fully, no shadowing', () => {
			const ws = [cmd('a'), cmd('b')];
			const gl = [cmd('c'), cmd('d')];
			const r = mergeProjectCommandsByPriority(ws, gl);
			assert.deepStrictEqual(r.merged.map(c => c.id), ['a', 'b', 'c', 'd']);
			assert.deepStrictEqual(r.shadowedGlobalIds, []);
		});

		test('workspace wins on id collision; global shadowed reported', () => {
			const ws = [cmd('a', 'workspace-a'), cmd('b')];
			const gl = [cmd('a', 'global-a'), cmd('c')];
			const r = mergeProjectCommandsByPriority(ws, gl);
			assert.deepStrictEqual(r.merged.map(c => c.id), ['a', 'b', 'c']);
			assert.strictEqual(r.merged[0].name, 'workspace-a');
			assert.deepStrictEqual(r.shadowedGlobalIds, ['a']);
		});

		test('workspace duplicates are deduped first-seen', () => {
			const ws = [cmd('a', 'first'), cmd('a', 'second')];
			const gl: ProjectCommand[] = [];
			const r = mergeProjectCommandsByPriority(ws, gl);
			assert.deepStrictEqual(r.merged.map(c => c.name), ['first']);
		});

		test('global duplicates deduped first-seen, no double-shadow report', () => {
			const ws = [cmd('a')];
			const gl = [cmd('a', 'g1'), cmd('a', 'g2'), cmd('b')];
			const r = mergeProjectCommandsByPriority(ws, gl);
			assert.deepStrictEqual(r.merged.map(c => c.id), ['a', 'b']);
			assert.deepStrictEqual(r.shadowedGlobalIds, ['a', 'a']);
		});

		test('empty inputs → empty merged', () => {
			const r = mergeProjectCommandsByPriority([], []);
			assert.deepStrictEqual(r.merged, []);
			assert.deepStrictEqual(r.shadowedGlobalIds, []);
		});
	});
});
