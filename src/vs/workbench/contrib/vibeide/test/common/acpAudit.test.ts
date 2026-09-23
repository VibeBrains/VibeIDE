/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildAcpPermissionAudit, buildAcpSessionAudit, buildAcpToolCallAudit, permissionOutcomeOf } from '../../common/acp/acpAudit.js';

suite('acpAudit — гостевой агент в журнале аудита', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const scope = { agentId: 'claude', sessionId: 's-1' };

	test('правка гостя: кто, какой вызов, какие файлы и сколько строк', () => {
		assert.deepStrictEqual(buildAcpToolCallAudit({
			...scope,
			toolCallId: 'call-7',
			title: 'Edit src/math.js',
			name: 'edit_file',
			toolKind: 'edit',
			status: 'completed',
			paths: ['/ws/src/math.js'],
			diffs: [{ path: '/ws/src/math.js', oldText: 'a\nb', newText: 'a\nb\nc' }],
		}, 1000), {
			ts: 1000,
			actor: 'guest',
			actorId: 'claude',
			action: 'acp_tool_call',
			traceId: 's-1',
			toolCallId: 'call-7',
			ok: true,
			files: ['/ws/src/math.js'],
			diffStats: { linesAdded: 3, linesRemoved: 2, hunks: 1 },
			meta: { name: 'edit_file', title: 'Edit src/math.js', toolKind: 'edit', status: 'completed' },
		});
	});

	test('заголовок команды в журнал не идёт, секрет в заголовке вырезается, длинный обрезается', () => {
		const call = (title: string, toolKind: string) => buildAcpToolCallAudit({
			...scope, toolCallId: 'c', title, name: '', toolKind, status: 'failed', paths: [], diffs: [],
		}, 1).meta;
		assert.deepStrictEqual({
			// For `execute` the title usually IS the command line — the same rule as for our own agent.
			команда: call('curl -H "Authorization: Bearer abc" https://example.com', 'execute'),
			секрет: call('Fetch with Authorization: Bearer abc', 'fetch'),
			длинный: (call('x '.repeat(150), 'read') as { title: string }).title.length,
		}, {
			команда: { toolKind: 'execute', status: 'failed' },
			секрет: { title: '[REDACTED LINE]', toolKind: 'fetch', status: 'failed' },
			длинный: 201,
		});
	});

	test('ответ человека читается по виду варианта, а не по факту выбора', () => {
		// The options are the guest's own, and one of them may well mean «no».
		assert.deepStrictEqual(
			['allow_once', 'allow_always', 'reject_once', 'reject_always', 'something_else', undefined].map(permissionOutcomeOf),
			['allowed', 'allowed', 'rejected', 'rejected', 'selected', 'cancelled']);
		assert.deepStrictEqual(buildAcpPermissionAudit({
			...scope, toolCallId: 'call-7', title: 'Прочитать .env', name: 'read_file', toolKind: 'read', paths: ['/ws/.env'], optionKind: 'reject_once',
		}, 5), {
			ts: 5,
			actor: 'human',
			action: 'acp_permission',
			traceId: 's-1',
			toolCallId: 'call-7',
			ok: false,
			files: ['/ws/.env'],
			meta: { agentId: 'claude', outcome: 'rejected', optionKind: 'reject_once', name: 'read_file', title: 'Прочитать .env', toolKind: 'read' },
		});
	});

	test('границы сессии: открывает и переподключает человек, обрыв — событие гостя', () => {
		assert.deepStrictEqual([
			buildAcpSessionAudit({ ...scope, phase: 'started' }, 1),
			buildAcpSessionAudit({ ...scope, phase: 'reconnected', reconnectMode: 'resume' }, 2),
			buildAcpSessionAudit({ ...scope, phase: 'failed', error: 'процесс агента завершился с кодом 1' }, 3),
		], [
			{ ts: 1, actor: 'human', action: 'acp_session', traceId: 's-1', ok: true, meta: { phase: 'started', agentId: 'claude' } },
			{ ts: 2, actor: 'human', action: 'acp_session', traceId: 's-1', ok: true, meta: { phase: 'reconnected', agentId: 'claude', reconnectMode: 'resume' } },
			{ ts: 3, actor: 'guest', actorId: 'claude', action: 'acp_session', traceId: 's-1', ok: false, meta: { phase: 'failed', error: 'процесс агента завершился с кодом 1' } },
		]);
	});
});
