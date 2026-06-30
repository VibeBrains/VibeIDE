/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	commandIdToRegistryId,
	registryIdToCommandId,
	formatProjectCommandKeybindingLabel,
	formatProjectCommandKeybindingLabels,
	PROJECT_COMMAND_REGISTRY_PREFIX,
} from '../../common/projectCommandsRegistryId.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Project Commands — registry-id + keybinding label formatters', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('commandIdToRegistryId', () => {
		test('valid id → prefixed registry id', () => {
			assert.strictEqual(commandIdToRegistryId('build-react'), 'vibeide.commands.run.build-react');
			assert.strictEqual(commandIdToRegistryId('a'), 'vibeide.commands.run.a');
		});

		test('invalid id → null (does not throw)', () => {
			assert.strictEqual(commandIdToRegistryId(''), null);
			assert.strictEqual(commandIdToRegistryId('Build'), null);
			assert.strictEqual(commandIdToRegistryId('build_react'), null);
			assert.strictEqual(commandIdToRegistryId('build react'), null);
			assert.strictEqual(commandIdToRegistryId('-leading'), null);
			assert.strictEqual(commandIdToRegistryId('a'.repeat(65)), null);
		});

		test('non-string → null', () => {
			assert.strictEqual(commandIdToRegistryId(undefined as unknown as string), null);
			assert.strictEqual(commandIdToRegistryId(42 as unknown as string), null);
		});

		test('PROJECT_COMMAND_REGISTRY_PREFIX exported for adoption', () => {
			assert.strictEqual(PROJECT_COMMAND_REGISTRY_PREFIX, 'vibeide.commands.run.');
		});
	});

	suite('registryIdToCommandId', () => {
		test('round-trip with valid id', () => {
			assert.strictEqual(registryIdToCommandId('vibeide.commands.run.build-react'), 'build-react');
		});

		test('rejects unrelated commands', () => {
			assert.strictEqual(registryIdToCommandId('vibeide.openSettings'), null);
			assert.strictEqual(registryIdToCommandId('workbench.action.terminal.new'), null);
		});

		test('rejects malformed suffix even with right prefix', () => {
			assert.strictEqual(registryIdToCommandId('vibeide.commands.run.Build'), null);
			assert.strictEqual(registryIdToCommandId('vibeide.commands.run.'), null);
			assert.strictEqual(registryIdToCommandId('vibeide.commands.run.has space'), null);
		});

		test('non-string → null', () => {
			assert.strictEqual(registryIdToCommandId(null as unknown as string), null);
			assert.strictEqual(registryIdToCommandId(7 as unknown as string), null);
		});
	});

	suite('formatProjectCommandKeybindingLabel', () => {
		test('uses name when present', () => {
			assert.strictEqual(formatProjectCommandKeybindingLabel({ id: 'br', name: 'Build React' }), 'Project: Build React');
		});

		test('trims whitespace in name', () => {
			assert.strictEqual(formatProjectCommandKeybindingLabel({ id: 'br', name: '   Build  ' }), 'Project: Build');
		});

		test('falls back to id when name empty/whitespace', () => {
			assert.strictEqual(formatProjectCommandKeybindingLabel({ id: 'build-react', name: '' }), 'Project: build-react');
			assert.strictEqual(formatProjectCommandKeybindingLabel({ id: 'build-react', name: '   ' }), 'Project: build-react');
		});

		test('preserves cyrillic / unicode name verbatim', () => {
			assert.strictEqual(formatProjectCommandKeybindingLabel({ id: 'sb', name: 'Сборка React' }), 'Project: Сборка React');
		});
	});

	suite('formatProjectCommandKeybindingLabels (bulk)', () => {
		test('preserves input order, drops invalid ids silently', () => {
			const out = formatProjectCommandKeybindingLabels([
				{ id: 'a', name: 'A' },
				{ id: 'BAD ID', name: 'will be dropped' },
				{ id: 'b', name: 'B' },
			]);
			assert.deepStrictEqual(out, [
				{ registryId: 'vibeide.commands.run.a', label: 'Project: A' },
				{ registryId: 'vibeide.commands.run.b', label: 'Project: B' },
			]);
		});

		test('empty input → empty output', () => {
			assert.deepStrictEqual(formatProjectCommandKeybindingLabels([]), []);
		});
	});
});
