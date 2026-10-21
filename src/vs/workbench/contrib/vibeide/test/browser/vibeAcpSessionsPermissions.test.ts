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
import { AcpEvent, IAcpPermissionRequest, IAcpSession } from '../../common/acp/acpTypes.js';
import { VibeAgentEntry } from '../../common/acp/vibeAgentsFile.js';
import { AuditEvent } from '../../common/auditLogService.js';

/**
 * The gate between an external agent's question and the person: what the mode answers by itself and what it does not
 * The services around it are stand-ins; what is under test is the order of the checkpoint, the verdict and the answer
 */
suite('VibeAcpSessionsService — кто отвечает на вопрос внешнего агента', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const agent: VibeAgentEntry = { id: 'claude', name: 'Claude Agent', command: 'npx' };
	const options = [
		{ optionId: 'allow', name: 'Allow', kind: 'allow_once' },
		{ optionId: 'reject', name: 'Reject', kind: 'reject_once' },
	];

	function setup() {
		const events = new Emitter<AcpEvent>();
		disposables.add(events);
		const answers: { requestId: string; optionId: string | undefined }[] = [];
		const snapshots = { created: [] as string[][], discarded: [] as string[] };
		const audit: AuditEvent[] = [];
		let counter = 0;
		const service = disposables.add(new VibeAcpSessionsService(
			{
				onEvent: events.event,
				startSession: async (): Promise<IAcpSession> => ({ sessionId: 's1', agentName: 'Claude Agent', promptCapabilities: { image: false, audio: false, embeddedContext: true } }),
				answerPermission: async (requestId: string, optionId: string | undefined) => { answers.push({ requestId, optionId }); },
				cancel: async () => { },
				endSession: async () => { },
			} as never,
			{ issue: async () => undefined, revoke: async () => { } } as never,
			{ launchOf: () => ({ name: 'Claude Agent', command: 'npx', args: [], cwd: '/ws/app' }), agents: [agent] } as never,
			{
				isEnabled: () => true,
				createSnapshot: async (files: string[]) => { snapshots.created.push(files); return { id: `snap${++counter}` }; },
				discardSnapshot: async (id: string) => { snapshots.discarded.push(id); },
			} as never,
			{ logStarted: () => { }, logFinished: () => { }, logError: () => { } } as never,
			{ info: () => { }, error: () => { }, prompt: () => { } } as never,
			{ isEnabled: () => true, append: async (event: AuditEvent) => { audit.push(event); } } as never,
			new TestConfigurationService(),
			{ detectSecrets: (text: string) => ({ redactedText: text }) } as never,
			{ getWorkspace: () => ({ folders: [{ uri: URI.file('/ws/app') }] }) } as never,
			disposables.add(new InMemoryStorageService()),
		));
		return { service, events, answers, snapshots, audit };
	}

	const request = (overrides: Partial<IAcpPermissionRequest>): AcpEvent => ({
		kind: 'permission',
		request: {
			requestId: 'r1', sessionId: 's1', toolCallId: 'c1', title: 'Edit a.ts', name: 'Edit', toolKind: 'edit', command: '',
			detail: '', paths: ['/ws/app/src/a.ts'], diffs: [], options, ...overrides,
		},
	});
	const settle = () => new Promise(resolve => setTimeout(resolve, 0));
	const pendingOf = (service: VibeAcpSessionsService) => service.sessions[0].pendingPermission;

	test('вручную вопрос идёт человеку, и чекпоинт уже снят', async () => {
		const { service, events, answers, snapshots } = setup();
		await service.startSession(agent);
		events.fire(request({}));
		await settle();
		assert.deepStrictEqual([pendingOf(service)?.requestId, answers, snapshots.created], ['r1', [], [['/ws/app/src/a.ts']]]);
	});

	test('в режиме «Правки» правка в проекте отвечается сама разовым «да», чекпоинт остаётся, ответ записан в аудит как ответ системы', async () => {
		const { service, events, answers, snapshots, audit } = setup();
		await service.startSession(agent);
		await service.setPermissionMode('s1', 'edits');
		events.fire(request({}));
		await settle();
		const answer = audit.find(event => event.action === 'acp_permission');
		assert.deepStrictEqual(
			[pendingOf(service), answers, snapshots.created.length, snapshots.discarded, answer?.actor, (answer?.meta as { decidedBy?: string } | undefined)?.decidedBy],
			[undefined, [{ requestId: 'r1', optionId: 'allow' }], 1, [], 'system', 'policy']);
	});

	test('необратимая команда идёт человеку даже в автопилоте — с причиной', async () => {
		const { service, events, answers } = setup();
		await service.startSession(agent);
		await service.setPermissionMode('s1', 'auto');
		events.fire(request({ title: 'rm -rf ~/work', name: 'Bash', toolKind: 'execute', command: 'rm -rf ~/work', paths: [] }));
		await settle();
		assert.deepStrictEqual([pendingOf(service)?.requestId, service.sessions[0].pendingReason, answers], ['r1', 'irreversible', []]);
	});

	test('автопилот сам отвечает на удаление временной папки и папки проекта, а удаление вне них идёт человеку', async () => {
		const { service, events, answers } = setup();
		await service.startSession(agent);
		await service.setPermissionMode('s1', 'auto');
		const run = (requestId: string, command: string) => events.fire(request({ requestId, title: command, name: 'Bash', toolKind: 'execute', command, paths: [] }));
		run('r1', 'export VIBEAGENT_HOME=$(mktemp -d /tmp/va-XXXXXX) && node run.js && rm -rf $VIBEAGENT_HOME');
		run('r2', 'rm -rf build');
		run('r3', 'rm -rf /Users/me/Documents');
		await settle();
		assert.deepStrictEqual([answers.map(a => a.requestId), pendingOf(service)?.requestId, service.sessions[0].pendingReason], [['r1', 'r2'], 'r3', 'irreversible']);
	});

	test('автопилот отвечает на обычную команду сам; запрос без разрешающего варианта всё равно идёт человеку', async () => {
		const { service, events, answers } = setup();
		await service.startSession(agent);
		await service.setPermissionMode('s1', 'auto');
		events.fire(request({ requestId: 'r1', title: 'npm test', name: 'Bash', toolKind: 'execute', command: 'npm test', paths: [] }));
		events.fire(request({ requestId: 'r2', title: 'npm test', name: 'Bash', toolKind: 'execute', command: 'npm test', paths: [], options: [options[1]] }));
		await settle();
		assert.deepStrictEqual([answers.map(a => a.requestId), pendingOf(service)?.requestId], [['r1'], 'r2']);
	});

	test('«на сессию»: разрешение запоминается, и такой же вопрос дальше отвечается сам; чужое разрешение не принимается', async () => {
		const { service, events, answers } = setup();
		await service.startSession(agent);
		events.fire(request({ requestId: 'r1', title: 'npm test', name: 'Bash', toolKind: 'execute', command: 'npm test', paths: [] }));
		await settle();
		const offers = service.sessions[0].pendingGrantOffers;
		await service.answerPermission('s1', 'allow', { kind: 'command', prefix: 'npm' });
		assert.deepStrictEqual([offers, service.sessions[0].grants, answers.length], [[{ kind: 'command', prefix: 'npm test' }], [], 1]);

		events.fire(request({ requestId: 'r2', title: 'npm test', name: 'Bash', toolKind: 'execute', command: 'npm test', paths: [] }));
		await settle();
		await service.answerPermission('s1', 'allow', offers[0]);
		events.fire(request({ requestId: 'r3', title: 'npm test', name: 'Bash', toolKind: 'execute', command: 'npm test', paths: [] }));
		await settle();
		assert.deepStrictEqual([service.sessions[0].grants, answers.map(a => a.requestId), pendingOf(service)], [[{ kind: 'command', prefix: 'npm test' }], ['r1', 'r2', 'r3'], undefined]);
	});

	test('сброс разрешений возвращает вопросы', async () => {
		const { service, events } = setup();
		await service.startSession(agent);
		events.fire(request({ requestId: 'r1', title: 'npm test', name: 'Bash', toolKind: 'execute', command: 'npm test', paths: [] }));
		await settle();
		await service.answerPermission('s1', 'allow', service.sessions[0].pendingGrantOffers[0]);
		service.clearGrants('s1');
		events.fire(request({ requestId: 'r2', title: 'npm test', name: 'Bash', toolKind: 'execute', command: 'npm test', paths: [] }));
		await settle();
		assert.deepStrictEqual([service.sessions[0].grants, pendingOf(service)?.requestId], [[], 'r2']);
	});

	test('отказ вариантом агента отбрасывает чекпоинт так же, как отмена', async () => {
		const { service, events, snapshots } = setup();
		await service.startSession(agent);
		events.fire(request({}));
		await settle();
		await service.answerPermission('s1', 'reject');
		assert.deepStrictEqual(snapshots.discarded, ['snap1']);
	});

	test('команды, которые агент объявил, помнятся после конца сессии: меню «/» нового разговора не пустеет', async () => {
		const { service, events } = setup();
		assert.deepStrictEqual(service.commandsOf('claude'), []);
		await service.startSession(agent);
		events.fire({ kind: 'commands', sessionId: 's1', commands: [{ name: 'review', description: 'Проверить изменения' }] });
		await service.endSession('s1');
		assert.deepStrictEqual(service.commandsOf('claude'), [{ name: 'review', description: 'Проверить изменения' }]);
	});
});
