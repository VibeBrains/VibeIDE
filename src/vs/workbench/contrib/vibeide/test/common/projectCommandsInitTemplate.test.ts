/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	buildProjectCommandsInitTemplate,
	serializeProjectCommandsInitTemplate,
	PROJECT_COMMANDS_INIT_EXAMPLE_ID,
} from '../../common/projectCommandsInitTemplate.js';
import { decodeProjectCommandsFile } from '../../common/projectCommandsTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Project Commands — first-run init template', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('build → valid example command pinned at order 0', () => {
		const f = buildProjectCommandsInitTemplate({ vibeVersion: '1.0.0' });
		assert.strictEqual(f.vibeVersion, '1.0.0');
		assert.strictEqual(f.commands.length, 1);
		const c = f.commands[0];
		assert.strictEqual(c.id, PROJECT_COMMANDS_INIT_EXAMPLE_ID);
		assert.strictEqual(c.name, 'Hello from VibeIDE');
		assert.strictEqual(c.command, 'echo');
		assert.deepStrictEqual(c.args, ['Hello', 'from', 'VibeIDE']);
		assert.strictEqual(c.terminal, 'integrated');
		assert.strictEqual(c.pinned, true);
		assert.strictEqual(c.order, 0);
	});

	test('build is round-trippable through decodeProjectCommandsFile', () => {
		const f = buildProjectCommandsInitTemplate({ vibeVersion: '1.0.0' });
		const json = JSON.parse(JSON.stringify(f)); // strip class-y prototypes
		const r = decodeProjectCommandsFile(json);
		assert.strictEqual(r.ok, true);
	});

	test('serialise produces JSON with _comment fields and trailing newline', () => {
		const text = serializeProjectCommandsInitTemplate({ vibeVersion: '1.0.0' });
		assert.ok(text.includes('_comment_top'));
		assert.ok(text.includes('_comment_docs'));
		assert.ok(text.includes('_comment_id'));
		assert.ok(text.endsWith('\n'));
	});

	test('serialise uses tabs for indent (project convention)', () => {
		const text = serializeProjectCommandsInitTemplate({ vibeVersion: '1.0.0' });
		assert.ok(text.includes('\t"vibeVersion"'));
	});

	test('serialised JSON parses + strict decoder accepts (drops _comment_*)', () => {
		const text = serializeProjectCommandsInitTemplate({ vibeVersion: '2.4.6' });
		const parsed = JSON.parse(text);
		// _comment fields are present in raw, but the decoder tolerates extras
		assert.ok(Object.hasOwn(parsed, '_comment_top'));
		const r = decodeProjectCommandsFile(parsed);
		assert.strictEqual(r.ok, true);
		if (r.ok) {
			assert.strictEqual(r.value.vibeVersion, '2.4.6');
			assert.strictEqual(r.value.commands.length, 1);
			assert.strictEqual(r.value.commands[0].id, PROJECT_COMMANDS_INIT_EXAMPLE_ID);
		}
	});

	test('vibeVersion is forwarded as-is', () => {
		const f = buildProjectCommandsInitTemplate({ vibeVersion: '0.0.1' });
		assert.strictEqual(f.vibeVersion, '0.0.1');
	});

	test('PROJECT_COMMANDS_INIT_EXAMPLE_ID is "example"', () => {
		assert.strictEqual(PROJECT_COMMANDS_INIT_EXAMPLE_ID, 'example');
	});
});
