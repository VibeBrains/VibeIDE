/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentSessionIdentity, compareAgentSessionIdentity, computeAgentSessionFingerprint, sessionMismatchToRussian } from '../../common/agentRunFingerprint.js';

const IDENTITY: AgentSessionIdentity = {
	role: 'explore',
	provider: 'anthropic',
	model: 'claude-opus-5',
	parentThreadId: 'thread-1',
	workspaceKey: '/repo',
	allowedTools: ['read_file', 'grep'],
};

suite('agentRunFingerprint — when a run may resume', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('fingerprint is stable, tool order is not identity, any field change moves it', () => {
		const same = computeAgentSessionFingerprint(IDENTITY);
		assert.deepStrictEqual(
			[
				computeAgentSessionFingerprint(IDENTITY) === same,
				computeAgentSessionFingerprint({ ...IDENTITY, allowedTools: ['grep', 'read_file'] }) === same,
				computeAgentSessionFingerprint({ ...IDENTITY, model: 'claude-sonnet-5' }) === same,
				computeAgentSessionFingerprint({ ...IDENTITY, allowedTools: ['read_file'] }) === same,
			],
			[true, true, false, false],
		);
	});

	test('mismatch names the field that moved; identical identities resume', () => {
		assert.deepStrictEqual(
			[
				compareAgentSessionIdentity(IDENTITY, IDENTITY),
				compareAgentSessionIdentity(IDENTITY, { ...IDENTITY, role: 'planner' }),
				compareAgentSessionIdentity(IDENTITY, { ...IDENTITY, parentThreadId: 'thread-2' }),
				compareAgentSessionIdentity(IDENTITY, { ...IDENTITY, workspaceKey: '/other' }),
				compareAgentSessionIdentity(IDENTITY, { ...IDENTITY, provider: 'openai' }),
				compareAgentSessionIdentity(IDENTITY, { ...IDENTITY, model: 'gpt-5' }),
				compareAgentSessionIdentity(IDENTITY, { ...IDENTITY, allowedTools: ['read_file'] }),
				compareAgentSessionIdentity(IDENTITY, { ...IDENTITY, allowedTools: ['grep', 'read_file'] }),
			],
			[
				undefined, 'role_changed', 'thread_changed', 'workspace_changed', 'provider_changed',
				'model_changed', 'tools_changed', undefined,
			],
		);
	});

	test('every mismatch has a Russian cause for the run list', () => {
		assert.deepStrictEqual(
			[
				sessionMismatchToRussian('model_changed'),
				sessionMismatchToRussian('workspace_changed'),
				sessionMismatchToRussian('tools_changed'),
			],
			['сменилась модель', 'сменилась рабочая папка', 'сменился набор инструментов'],
		);
	});
});
