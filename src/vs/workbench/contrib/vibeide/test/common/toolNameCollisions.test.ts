/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveToolNameCollisions } from '../../common/prompt/toolNameCollisions.js';
import type { InternalToolInfo } from '../../common/prompt/prompts.js';

/**
 * Столкновение имён встроенного инструмента и инструмента с MCP-сервера.
 *
 * Two failure modes, both bad in their own way: a strict provider rejects the whole request over a
 * duplicate name, and a permissive one accepts it — letting a server silently take over `edit_file`.
 * The tests pin the rule that avoids both: the built-in keeps its name, the newcomer is renamed and
 * stays callable.
 */
suite('tool name collisions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const tool = (name: string, description = name): InternalToolInfo =>
		({ name, description, params: {} } as InternalToolInfo);
	const builtins = new Set(['read_file', 'edit_file', 'run_command']);

	test('the built-in keeps its name and the newcomer is renamed', () => {
		const { tools, collisions } = resolveToolNameCollisions(
			[tool('read_file'), tool('search_web'), tool('read_file', 'умеет читать из хранилища')],
			builtins,
		);
		assert.deepStrictEqual(tools.map(t => t.name), ['read_file', 'search_web', 'read_file_mcp']);
		assert.deepStrictEqual(collisions, [{ requested: 'read_file', renamed: 'read_file_mcp', serverName: undefined }]);
	});

	/** A renamed tool must still be usable, so the model is told what its own server calls it. */
	test('the rename explains itself in the description', () => {
		const { tools } = resolveToolNameCollisions([tool('edit_file'), tool('edit_file', 'правит удалённо')], builtins);
		const renamed = tools[1];
		assert.strictEqual(renamed.name, 'edit_file_mcp');
		assert.ok(renamed.description.includes('правит удалённо'), 'исходное описание сохраняется');
		assert.ok(renamed.description.includes('edit_file'), 'исходное имя названо');
	});

	test('two servers claiming one name still resolve, and deterministically', () => {
		const first = resolveToolNameCollisions(
			[tool('run_command'), tool('run_command', 'сервер А'), tool('run_command', 'сервер Б')],
			builtins,
		);
		assert.deepStrictEqual(first.tools.map(t => t.name), ['run_command', 'run_command_mcp', 'run_command_mcp2']);
		// Same input, same output: a bug report that cannot be reproduced is not a bug report.
		const second = resolveToolNameCollisions(
			[tool('run_command'), tool('run_command', 'сервер А'), tool('run_command', 'сервер Б')],
			builtins,
		);
		assert.deepStrictEqual(second.tools.map(t => t.name), first.tools.map(t => t.name));
	});

	test('the server is named in the report, so the user knows whom to ask', () => {
		const contributed = tool('read_file', 'из моего сервера');
		const { collisions } = resolveToolNameCollisions(
			[tool('read_file'), contributed],
			builtins,
			t => t === contributed ? 'my-server' : undefined,
		);
		assert.deepStrictEqual(collisions, [{ requested: 'read_file', renamed: 'read_file_mcp', serverName: 'my-server' }]);
	});

	test('a list without collisions is passed through unchanged', () => {
		const input = [tool('read_file'), tool('search_web'), tool('deploy')];
		const { tools, collisions } = resolveToolNameCollisions(input, builtins);
		assert.deepStrictEqual(tools.map(t => t.name), ['read_file', 'search_web', 'deploy']);
		assert.deepStrictEqual(collisions, []);
	});
});
