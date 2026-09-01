/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { buildToolCallAudit, toolCallTargetPath, writesToSharedState } from '../../common/toolCallAudit.js';

suite('Tool call audit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// A REAL `URI`, not an object literal: `fsPath` is a getter on the prototype, and the first
	// version of this check used `Object.hasOwn`, which is false for every real URI. The literal
	// made the test pass while the runtime recorded no path at all.
	test('file tools contribute their target path', () => {
		assert.deepStrictEqual(
			buildToolCallAudit({ toolName: 'edit_file', params: { uri: URI.file('/repo/src/a.ts'), searchReplaceBlocks: 'secret-ish' } }),
			{ files: [URI.file('/repo/src/a.ts').fsPath], meta: { tool: 'edit_file' } },
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
		const target = toolCallTargetPath({ toolName: 'read_file', params: { uri: URI.file(long) } });
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

	/**
	 * `.vibe/` is state one run leaves for the next — plans, locks, artifacts — which makes it a
	 * channel between agents and not merely config. We do not forbid the writes (our own
	 * orchestration works through them); we make them answerable in the log.
	 */
	suite('writes into the shared .vibe folder are flagged', () => {
		test('a write inside .vibe is flagged, a read of the same path is not', () => {
			assert.strictEqual(writesToSharedState('edit_file', '.vibe/plans/current.json'), true);
			assert.strictEqual(writesToSharedState('rewrite_file', '/repo/.vibe/agent-locks.json'), true);
			assert.strictEqual(writesToSharedState('create_file_or_folder', '.vibe'), true);
			// Reading rules and skills happens every turn — flagging it would train people to ignore
			// the flag.
			assert.strictEqual(writesToSharedState('read_file', '.vibe/rules.md'), false);
			assert.strictEqual(writesToSharedState('ls_dir', '.vibe'), false);
		});

		test('lookalike paths are not mistaken for the shared folder', () => {
			assert.strictEqual(writesToSharedState('edit_file', '.vibe-defaults/providers.jsonc'), false);
			assert.strictEqual(writesToSharedState('edit_file', 'src/my.vibe/thing.json'), false);
			assert.strictEqual(writesToSharedState('edit_file', 'src/app.ts'), false);
			assert.strictEqual(writesToSharedState('edit_file', undefined), false);
		});

		test('the flag reaches the audit event, and stays absent for ordinary files', () => {
			// Params carry a real URI, exactly as the tool receives it — the path is read off
			// `fsPath`, so a plain string here would test nothing that happens in production.
			const shared = URI.file('/repo/.vibe/plans/p1.json');
			assert.deepStrictEqual(
				buildToolCallAudit({ toolName: 'edit_file', params: { uri: shared } }),
				{ files: [shared.fsPath], meta: { tool: 'edit_file', sharedState: true } },
			);
			const ordinary = URI.file('/repo/src/app.ts');
			assert.deepStrictEqual(
				buildToolCallAudit({ toolName: 'edit_file', params: { uri: ordinary } }),
				{ files: [ordinary.fsPath], meta: { tool: 'edit_file' } },
			);
		});
	});
});
