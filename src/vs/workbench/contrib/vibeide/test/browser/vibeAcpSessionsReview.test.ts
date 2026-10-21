/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { VibeAcpSessionsService } from '../../browser/acp/vibeAcpSessionsService.js';
import { IVibeAcpEditCall } from '../../browser/acp/vibeAcpEditReview.js';
import { AcpEvent, IAcpSession } from '../../common/acp/acpTypes.js';
import { AcpFileBefore } from '../../common/acp/acpEditBaseline.js';
import { VibeAgentEntry } from '../../common/acp/vibeAgentsFile.js';

/**
 * Что из рассказа внешнего агента сессия отдаёт на разбор правок
 * Само решение, что ставить на разбор, принимает служба разбора; здесь проверяется только проводка событий
 */
suite('VibeAcpSessionsService — проводка правок на разбор', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const agent: VibeAgentEntry = { id: 'claude', name: 'Claude Agent', command: 'npx' };
	const path = '/ws/app/src/a.ts';

	function setup() {
		const events = new Emitter<AcpEvent>();
		disposables.add(events);
		const calls: string[] = [];
		const settled: IVibeAcpEditCall[] = [];
		const remembered: AcpFileBefore[][] = [];
		const service = disposables.add(new VibeAcpSessionsService(
			{
				onEvent: events.event,
				startSession: async (): Promise<IAcpSession> => ({ sessionId: 's1', agentName: 'Claude Agent', promptCapabilities: { image: false, audio: false, embeddedContext: true } }),
				prompt: async () => 'completed',
				answerPermission: async () => { },
				cancel: async () => { },
				endSession: async () => { },
			} as never,
			{ issue: async () => undefined, revoke: async () => { } } as never,
			{ launchOf: () => ({ name: 'Claude Agent', command: 'npx', args: [], cwd: '/ws/app' }), agents: [agent] } as never,
			{ isEnabled: () => false } as never,
			{ logStarted: () => { }, logFinished: () => { }, logError: () => { } } as never,
			{ info: () => { }, error: () => { }, prompt: () => { } } as never,
			{ isEnabled: () => false } as never,
			new TestConfigurationService(),
			{ detectSecrets: (text: string) => ({ redactedText: text }) } as never,
			{ getWorkspace: () => ({ folders: [{ uri: URI.file('/ws/app') }] }) } as never,
			disposables.add(new InMemoryStorageService()),
			{
				beginTurn: (sessionId: string) => { calls.push(`beginTurn ${sessionId}`); },
				remember: (_sessionId: string, files: AcpFileBefore[]) => { remembered.push(files); },
				settle: async (_sessionId: string, call: IVibeAcpEditCall) => { settled.push(call); },
				settleWritten: async (_sessionId: string, written: string) => { calls.push(`written ${written}`); },
				forget: (sessionId: string) => { calls.push(`forget ${sessionId}`); },
			} as never,
		));
		return { service, events, calls, settled, remembered };
	}

	const tool = (overrides: Partial<Extract<AcpEvent, { kind: 'tool' }>>): AcpEvent => ({
		kind: 'tool', sessionId: 's1', toolCallId: 'c1', title: 'Edit', name: 'Edit', toolKind: 'edit', status: 'pending', paths: [path], diffs: [], output: '', ...overrides,
	});

	test('база, снятая до правки, и завершённая правка доходят до службы разбора; дифф берётся из накопленной карточки', async () => {
		const { service, events, remembered, settled } = setup();
		await service.startSession(agent);
		events.fire({ kind: 'before', sessionId: 's1', files: [{ path, state: 'text', text: 'return 1;' }] });
		events.fire(tool({ status: 'in_progress', diffs: [{ path, oldText: 'return 1;', newText: 'return 2;' }] }));
		// Завершающий кадр приходит без диффа: он остаётся в карточке от прежних кадров
		events.fire(tool({ status: 'completed', paths: [], diffs: [] }));
		assert.deepStrictEqual([remembered, settled], [
			[[{ path, state: 'text', text: 'return 1;' }]],
			[{ toolKind: 'edit', status: 'completed', paths: [path], diffs: [{ path, oldText: 'return 1;', newText: 'return 2;' }] }],
		]);
	});

	test('кадры чужой сессии на разбор не идут', async () => {
		const { service, events, remembered, settled, calls } = setup();
		await service.startSession(agent);
		events.fire({ kind: 'before', sessionId: 'other', files: [{ path, state: 'absent' }] });
		events.fire(tool({ sessionId: 'other', status: 'completed' }));
		events.fire({ kind: 'wrote', sessionId: 'other', path });
		assert.deepStrictEqual([remembered, settled, calls], [[], [], []]);
	});

	test('файл, записанный агентом через нас, идёт на разбор', async () => {
		const { service, events, calls } = setup();
		await service.startSession(agent);
		events.fire({ kind: 'wrote', sessionId: 's1', path });
		assert.deepStrictEqual(calls, [`written ${path}`]);
	});

	test('ход начинает новый круг баз, конец сессии их забывает', async () => {
		const { service, calls } = setup();
		await service.startSession(agent);
		await service.prompt('s1', { text: 'правь' });
		await service.endSession('s1');
		assert.deepStrictEqual(calls, ['beginTurn s1', 'forget s1']);
	});
});
