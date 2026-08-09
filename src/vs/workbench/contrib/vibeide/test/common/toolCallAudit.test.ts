/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildToolCallAudit, toolCallTargetPath } from '../../common/toolCallAudit.js';

suite('Tool call audit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('file tools contribute their target path', () => {
		assert.deepStrictEqual(
			buildToolCallAudit({ toolName: 'edit_file', params: { uri: { fsPath: '/repo/src/a.ts' }, searchReplaceBlocks: 'secret-ish' } }),
			{ files: ['/repo/src/a.ts'], meta: { tool: 'edit_file' } },
		);
	});

	test('command bodies never reach the log — not as a target, not as meta', () => {
		const built = buildToolCallAudit({ toolName: 'run_command', params: { command: 'export TOKEN=hunter2 && deploy.sh', cwd: '/repo' } });
		assert.deepStrictEqual(built, { meta: { tool: 'run_command' } });
		assert.ok(!JSON.stringify(built).includes('hunter2'));
	});

	test('search queries are not a target either', () => {
		assert.strictEqual(toolCallTargetPath({ toolName: 'grep_search', params: { query: 'password =' } }), undefined);
	});

	test('MCP server is recorded, so a third-party tool is attributable', () => {
		assert.deepStrictEqual(
			buildToolCallAudit({ toolName: 'fetch', params: {}, mcpServerName: 'web-tools' }),
			{ meta: { tool: 'fetch', mcpServer: 'web-tools' } },
		);
	});

	test('an absurdly long path is truncated rather than logged whole', () => {
		const long = '/repo/' + 'x'.repeat(500) + '.ts';
		const target = toolCallTargetPath({ toolName: 'read_file', params: { uri: { fsPath: long } } });
		assert.strictEqual(target?.length, 260);
	});

	test('missing or shapeless params degrade to no target, never to a throw', () => {
		assert.deepStrictEqual(
			{
				none: toolCallTargetPath({ toolName: 'read_file', params: undefined }),
				empty: toolCallTargetPath({ toolName: 'read_file', params: {} }),
				odd: toolCallTargetPath({ toolName: 'read_file', params: { uri: 42 } }),
			},
			{ none: undefined, empty: undefined, odd: undefined },
		);
	});
});
