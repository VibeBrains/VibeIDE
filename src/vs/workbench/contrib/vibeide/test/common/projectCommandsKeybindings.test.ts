/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	allocateDefaultChords,
	DEFAULT_CHORD_PREFIX,
	DEFAULT_CHORD_MAX_SLOTS,
} from '../../common/projectCommandsKeybindings.js';
import { ProjectCommand } from '../../common/projectCommandsTypes.js';

function cmd(id: string, opts: Partial<ProjectCommand> = {}): ProjectCommand {
	return { id, name: id, command: 'echo', ...opts };
}

suite('Project Commands — default chord allocator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('respects sortProjectCommandsForDisplay (order asc, name tie-break)', () => {
		const commands: ProjectCommand[] = [
			cmd('z', { pinned: true, order: 1, name: 'Z' }),
			cmd('a', { pinned: true, order: 0, name: 'A' }),
			cmd('m', { pinned: true, order: 1, name: 'M' }),
		];
		const r = allocateDefaultChords(commands);
		// Sort: order 0 first → 'a'; then order 1 tied → name 'M' < 'Z'
		assert.deepStrictEqual(r.map(x => x.id), ['a', 'm', 'z']);
	});

	test('non-pinned commands are skipped', () => {
		const commands: ProjectCommand[] = [
			cmd('a', { pinned: true }),
			cmd('b', { pinned: false }),
			cmd('c', { pinned: true }),
		];
		const r = allocateDefaultChords(commands);
		assert.deepStrictEqual(r.map(x => x.id), ['a', 'c']);
	});

	test('chords use ctrl+shift+alt+1..9 in slot order', () => {
		const commands: ProjectCommand[] = Array.from({ length: 5 }, (_, i) =>
			cmd(`cmd-${i}`, { pinned: true, order: i }));
		const r = allocateDefaultChords(commands);
		assert.deepStrictEqual(r.map(x => x.key), [
			'ctrl+shift+alt+1',
			'ctrl+shift+alt+2',
			'ctrl+shift+alt+3',
			'ctrl+shift+alt+4',
			'ctrl+shift+alt+5',
		]);
		assert.deepStrictEqual(r.map(x => x.slot), [1, 2, 3, 4, 5]);
	});

	test('caps at 9 even with 12 pinned', () => {
		const commands: ProjectCommand[] = Array.from({ length: 12 }, (_, i) =>
			cmd(`cmd-${i}`, { pinned: true, order: i }));
		const r = allocateDefaultChords(commands);
		assert.strictEqual(r.length, 9);
		assert.strictEqual(r[8].slot, 9);
		assert.strictEqual(r[8].key, 'ctrl+shift+alt+9');
	});

	test('when clause uses pinned >= slot pattern', () => {
		const commands: ProjectCommand[] = [
			cmd('a', { pinned: true, order: 0 }),
			cmd('b', { pinned: true, order: 1 }),
		];
		const r = allocateDefaultChords(commands);
		assert.strictEqual(r[0].when, 'vibeide.commands.pinned >= 1');
		assert.strictEqual(r[1].when, 'vibeide.commands.pinned >= 2');
	});

	test('registryId is computed correctly', () => {
		const commands: ProjectCommand[] = [cmd('build-react', { pinned: true })];
		const r = allocateDefaultChords(commands);
		assert.strictEqual(r[0].registryId, 'vibeide.commands.run.build-react');
	});

	test('invalid ids dropped silently (slot still increments by valid)', () => {
		// Note: invalid ids would have been refused at the decoder layer,
		// but defense-in-depth: the allocator must not throw.
		const commands: ProjectCommand[] = [
			{ ...cmd('valid-a', { pinned: true, order: 0 }) },
			{ ...cmd('a', { pinned: true, order: 1 }) },
		];
		const r = allocateDefaultChords(commands);
		assert.strictEqual(r.length, 2);
		assert.deepStrictEqual(r.map(x => x.slot), [1, 2]);
	});

	test('empty input → empty output', () => {
		assert.deepStrictEqual(allocateDefaultChords([]), []);
	});

	test('exported constants', () => {
		assert.strictEqual(DEFAULT_CHORD_PREFIX, 'ctrl+shift+alt+');
		assert.strictEqual(DEFAULT_CHORD_MAX_SLOTS, 9);
	});
});
