/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	PROJECT_COMMANDS_PALETTE_IDS,
	isProjectCommandsPaletteId,
	validateDidChangeCommandsEvent,
	validateDidStartCommandEvent,
	validateDidEndCommandEvent,
	pickTopBarPinned,
} from '../../common/projectCommandsServiceContract.js';
import { ProjectCommand, sortProjectCommandsForDisplay } from '../../common/projectCommandsTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function cmd(id: string, opts: Partial<ProjectCommand> = {}): ProjectCommand {
	return { id, name: id, command: 'echo', ...opts };
}

suite('Project Commands — service contract: palette ids + events + top-bar pinned', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('palette ids', () => {
		test('all values are vibeide.commands.* prefixed', () => {
			for (const v of Object.values(PROJECT_COMMANDS_PALETTE_IDS)) {
				assert.ok(v.startsWith('vibeide.commands.'), `${v} should start with vibeide.commands.`);
			}
		});

		test('isProjectCommandsPaletteId positive', () => {
			assert.strictEqual(isProjectCommandsPaletteId('vibeide.commands.runFromPalette'), true);
			assert.strictEqual(isProjectCommandsPaletteId('vibeide.commands.add'), true);
		});

		test('isProjectCommandsPaletteId negative', () => {
			assert.strictEqual(isProjectCommandsPaletteId('vibeide.openSettings'), false);
			assert.strictEqual(isProjectCommandsPaletteId('vibeide.commands.run.build'), false);
			assert.strictEqual(isProjectCommandsPaletteId(42), false);
			assert.strictEqual(isProjectCommandsPaletteId(null), false);
		});

		test('frozen — cannot be mutated at runtime', () => {
			assert.throws(() => {
				(PROJECT_COMMANDS_PALETTE_IDS as Record<string, string>).injected = 'oops';
			});
		});
	});

	suite('validateDidChangeCommandsEvent', () => {
		test('happy path', () => {
			const r = validateDidChangeCommandsEvent({ commands: [], source: 'fs-change' });
			assert.deepStrictEqual(r, { commands: [], source: 'fs-change' });
		});

		test('rejects unknown source', () => {
			assert.strictEqual(validateDidChangeCommandsEvent({ commands: [], source: 'nonsense' }), null);
		});

		test('rejects non-array commands', () => {
			assert.strictEqual(validateDidChangeCommandsEvent({ commands: 'oops', source: 'init' }), null);
		});

		test('rejects null', () => {
			assert.strictEqual(validateDidChangeCommandsEvent(null), null);
		});
	});

	suite('validateDidStartCommandEvent', () => {
		test('happy path', () => {
			const r = validateDidStartCommandEvent({ id: 'a', name: 'A', invocationId: 'inv-1', startedAtMs: 1_000 });
			assert.ok(r);
			assert.strictEqual(r!.id, 'a');
		});

		test('rejects empty id / name / invocationId', () => {
			assert.strictEqual(validateDidStartCommandEvent({ id: '', name: 'A', invocationId: 'i', startedAtMs: 1 }), null);
			assert.strictEqual(validateDidStartCommandEvent({ id: 'a', name: '', invocationId: 'i', startedAtMs: 1 }), null);
			assert.strictEqual(validateDidStartCommandEvent({ id: 'a', name: 'A', invocationId: '', startedAtMs: 1 }), null);
		});

		test('rejects non-finite startedAtMs', () => {
			assert.strictEqual(validateDidStartCommandEvent({ id: 'a', name: 'A', invocationId: 'i', startedAtMs: NaN }), null);
		});
	});

	suite('validateDidEndCommandEvent', () => {
		test('happy path with exitCode + durationMs', () => {
			const r = validateDidEndCommandEvent({
				id: 'a', name: 'A', invocationId: 'i',
				endedAtMs: 2_000, outcome: 'success',
				exitCode: 0, durationMs: 500,
			});
			assert.ok(r);
			assert.strictEqual(r!.exitCode, 0);
			assert.strictEqual(r!.durationMs, 500);
		});

		test('outcome union enforced', () => {
			assert.strictEqual(validateDidEndCommandEvent({ id: 'a', name: 'A', invocationId: 'i', endedAtMs: 1, outcome: 'pending' }), null);
		});

		test('exitCode optional', () => {
			const r = validateDidEndCommandEvent({ id: 'a', name: 'A', invocationId: 'i', endedAtMs: 1, outcome: 'cancelled' });
			assert.ok(r);
			assert.strictEqual(Object.hasOwn(r!, 'exitCode'), false);
		});

		test('negative durationMs dropped silently', () => {
			const r = validateDidEndCommandEvent({
				id: 'a', name: 'A', invocationId: 'i',
				endedAtMs: 1, outcome: 'success', durationMs: -1,
			});
			assert.ok(r);
			assert.strictEqual(Object.hasOwn(r!, 'durationMs'), false);
		});
	});

	suite('pickTopBarPinned', () => {
		test('respects display order, splits at maxButtons', () => {
			const sorted = sortProjectCommandsForDisplay([
				cmd('a', { pinned: true, order: 1 }),
				cmd('b', { pinned: true, order: 2 }),
				cmd('c', { pinned: true, order: 3 }),
				cmd('d', { pinned: true, order: 4 }),
				cmd('e', { pinned: false }),
				cmd('f', { pinned: false }),
			]);
			const r = pickTopBarPinned(sorted, 3);
			assert.deepStrictEqual(r.pinned.map(c => c.id), ['a', 'b', 'c']);
			assert.deepStrictEqual(r.overflow.map(c => c.id), ['d', 'e', 'f']);
		});

		test('default maxButtons = 6', () => {
			const sorted = sortProjectCommandsForDisplay(
				Array.from({ length: 10 }, (_, i) => cmd(`p${i}`, { pinned: true, order: i })),
			);
			const r = pickTopBarPinned(sorted);
			assert.strictEqual(r.pinned.length, 6);
			assert.strictEqual(r.overflow.length, 4);
		});

		test('non-pinned go to overflow even if they are first by display order', () => {
			const sorted = [
				cmd('a', { pinned: false, order: 0 }),
				cmd('b', { pinned: true, order: 1 }),
			];
			const r = pickTopBarPinned(sorted, 5);
			assert.deepStrictEqual(r.pinned.map(c => c.id), ['b']);
			assert.deepStrictEqual(r.overflow.map(c => c.id), ['a']);
		});

		test('maxButtons clamped to floor of input', () => {
			const sorted = [cmd('a', { pinned: true })];
			const r = pickTopBarPinned(sorted, -1);
			assert.deepStrictEqual(r.pinned, []);
			assert.deepStrictEqual(r.overflow.map(c => c.id), ['a']);
		});

		test('empty input', () => {
			assert.deepStrictEqual(pickTopBarPinned([], 6), { pinned: [], overflow: [] });
		});
	});
});
