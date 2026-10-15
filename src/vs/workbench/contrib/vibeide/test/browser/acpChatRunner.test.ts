/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { AcpChatRunner, AcpThreadBinding, IAcpThreadPort } from '../../browser/acp/acpChatRunner.js';
import { IVibeAcpSessionView, IVibeAcpSessionsService, IVibeAcpPromptRequest } from '../../browser/acp/vibeAcpSessionsService.js';
import { IVibeAcpRegistryService } from '../../browser/acp/vibeAcpRegistryService.js';
import type { ThreadStreamState, ThreadType } from '../../browser/chatThreadService.js';
import { ChatMessage } from '../../common/chatThreadServiceTypes.js';
import { AcpReconnectMode, AcpStopReason } from '../../common/acp/acpProtocol.js';
import { AcpPermissionMode } from '../../common/acp/acpPermissionPolicy.js';
import { AcpSessionLog } from '../../common/acp/acpSessionLog.js';
import { VibeAgentEntry } from '../../common/acp/vibeAgentsFile.js';
import { IAcpSession } from '../../common/acp/acpTypes.js';

/** A session service that answers like the real one: a turn marks its start, goes busy, and ends with a reason */
class FakeSessions {
	private readonly _changes = new Emitter<void>();
	readonly onDidChange = this._changes.event;
	readonly log = new AcpSessionLog();
	readonly prompts: IVibeAcpPromptRequest[] = [];
	readonly cancels: string[] = [];
	readonly calls: string[] = [];
	sessionId = 's1';
	live = false;
	busy = false;
	turnStart = 0;
	error: string | undefined;
	lastStopReason: AcpStopReason | undefined;
	resumeMode: AcpReconnectMode = 'resume';
	mode: AcpPermissionMode = 'manual';
	readonly modes: AcpPermissionMode[] = [];
	/** What the agent does during a turn */
	script: () => Promise<void> = async () => { };
	/** Released by a test to let a long turn end */
	release: (() => void) | undefined;

	changed(): void { this._changes.fire(); }

	get sessions(): IVibeAcpSessionView[] {
		if (!this.live) { return []; }
		return [{
			sessionId: this.sessionId,
			agentId: 'claude',
			agentName: 'Claude Agent',
			busy: this.busy,
			lastStopReason: this.lastStopReason,
			error: this.error,
			disconnected: false,
			reconnecting: false,
			log: this.log.snapshot,
			pendingPermission: undefined,
			pendingGrantOffers: [],
			permissionMode: this.mode,
			grants: [],
			configOptions: [],
			configuring: false,
			commands: [],
			turnStart: this.turnStart,
			promptCapabilities: { image: false, audio: false, embeddedContext: true },
		}];
	}

	async startSession(): Promise<IAcpSession> {
		this.calls.push('start');
		this.live = true;
		return { sessionId: this.sessionId, agentName: 'Claude Agent', promptCapabilities: { image: false, audio: false, embeddedContext: true } };
	}

	async resumeSession(_agent: VibeAgentEntry, previous: string) {
		this.calls.push(`resume:${previous}`);
		this.live = true;
		return { session: { sessionId: this.resumeMode === 'new' ? 's2' : previous, agentName: 'Claude Agent', promptCapabilities: { image: false, audio: false, embeddedContext: true } }, mode: this.resumeMode };
	}

	async reconnect(): Promise<string | undefined> { return undefined; }

	async setPermissionMode(_sessionId: string, mode: AcpPermissionMode): Promise<void> {
		this.mode = mode;
		this.modes.push(mode);
	}

	async prompt(_sessionId: string, request: IVibeAcpPromptRequest): Promise<void> {
		this.prompts.push(request);
		this.turnStart = this.log.beginTurn();
		this.busy = true;
		this.error = undefined;
		this.lastStopReason = undefined;
		this.changed();
		try {
			await this.script();
			this.lastStopReason ??= 'completed';
		} finally {
			this.busy = false;
			this.changed();
		}
	}

	async cancel(sessionId: string): Promise<void> {
		this.cancels.push(sessionId);
		this.lastStopReason = 'cancelled';
		this.release?.();
	}

	async endSession(sessionId: string): Promise<void> {
		this.calls.push(`end:${sessionId}`);
		this.live = false;
	}
}

suite('AcpChatRunner — ход основного чата, который ведёт внешний агент', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { agents?: readonly VibeAgentEntry[]; binding?: AcpThreadBinding } = {}) {
		const sessions = new FakeSessions();
		const messages: ChatMessage[] = [];
		const streamStates: (ThreadStreamState[string])[] = [];
		const bindings: AcpThreadBinding[] = [];
		const thread = { id: 't1', messages, acpAgent: options.binding ?? { agentId: 'claude', agentName: 'Claude Agent' }, state: { stagingSelections: [] } } as unknown as ThreadType;
		const port: IAcpThreadPort = {
			getThread: () => thread,
			addUserMessage: (_id, message) => { messages.push({ role: 'user', content: message.content, displayContent: message.displayContent, selections: message.selections, state: { stagingSelections: [], isBeingEdited: false } }); },
			addMessage: (_id, message) => { messages.push({ ...message }); },
			editMessage: (_id, idx, message) => { messages[idx] = message; },
			setStreamState: (_id, state) => { streamStates.push(state); },
			setBinding: (_id, binding) => { thread.acpAgent = binding; bindings.push(binding); },
		};
		const agents = options.agents ?? [{ id: 'claude', name: 'Claude Agent', command: 'npx' }];
		const registry = { agents } as unknown as IVibeAcpRegistryService;
		const runner = disposables.add(new AcpChatRunner(
			port,
			sessions as unknown as IVibeAcpSessionsService,
			registry,
			new TestConfigurationService(),
			{ activeTextEditorControl: undefined, activeEditor: undefined, editors: [] } as never,
			{ getModel: () => null, getModels: () => [] } as never,
			{ readFile: async () => { throw new Error('нет файла'); } } as never,
			{ isIgnored: () => false } as never,
			{ append: () => { } } as never,
		));
		return { runner, sessions, messages, streamStates, bindings, thread };
	}

	const request = (text = 'изучи файл') => ({ threadId: 't1', text, displayContent: text, selections: [] });
	const roles = (messages: readonly ChatMessage[]) => messages.map(message => message.role === 'assistant' ? `assistant:${message.displayContent}` : message.role);

	test('ответ агента и его вызов инструмента ложатся в тред в порядке событий; сессия запоминается в треде', async () => {
		const { runner, sessions, messages, bindings, streamStates } = setup();
		sessions.script = async () => {
			sessions.log.appendText('Смотрю', false);
			sessions.log.applyTool({ toolCallId: 'tool1', title: 'git status', name: 'Bash', toolKind: 'execute', status: 'completed', paths: [], diffs: [], output: 'чисто', exitCode: 0 });
			sessions.log.appendText('Всё чисто', false);
			sessions.changed();
		};
		await runner.send(request());
		assert.deepStrictEqual(roles(messages), ['user', 'assistant:Смотрю', 'acp_tool', 'assistant:Всё чисто']);
		assert.deepStrictEqual([bindings, sessions.calls, streamStates[streamStates.length - 1]], [[{ agentId: 'claude', agentName: 'Claude Agent', sessionId: 's1' }], ['start'], undefined]);
	});

	test('растущая реплика переписывается на месте, а не дописывается новым сообщением', async () => {
		const { runner, sessions, messages } = setup();
		sessions.script = async () => {
			sessions.log.appendText('Смо', false);
			sessions.changed();
			await new Promise(resolve => setTimeout(resolve, 120));
			sessions.log.appendText('трю', false);
			sessions.changed();
		};
		await runner.send(request());
		assert.deepStrictEqual(roles(messages), ['user', 'assistant:Смотрю']);
	});

	test('карточка вызова, оборванная закрытием IDE, при следующем сообщении перестаёт «идти»', async () => {
		const { runner, messages } = setup();
		messages.push(
			{ role: 'acp_tool', toolCallId: 'a', title: 'curl', name: 'Bash', toolKind: 'execute', status: 'in_progress', paths: [], diffs: [], output: '' },
			{ role: 'acp_tool', toolCallId: 'b', title: 'ls', name: 'Bash', toolKind: 'execute', status: 'completed', paths: [], diffs: [], output: '' },
		);
		await runner.send(request());
		assert.deepStrictEqual(messages.filter(m => m.role === 'acp_tool').map(m => m.role === 'acp_tool' ? m.status : ''), ['cancelled', 'completed']);
	});

	test('ход следующего сообщения не склеивается с ответом прошлого', async () => {
		const { runner, sessions, messages } = setup();
		sessions.script = async () => { sessions.log.appendText('Первый', false); };
		await runner.send(request('раз'));
		sessions.script = async () => { sessions.log.appendText('Второй', false); };
		await runner.send(request('два'));
		assert.deepStrictEqual(roles(messages), ['user', 'assistant:Первый', 'user', 'assistant:Второй']);
		assert.deepStrictEqual(sessions.calls, ['start']);
	});

	test('после перезапуска тред возвращается в запомненную сессию; если агент её не помнит, об этом сказано в треде', async () => {
		const resumed = setup({ binding: { agentId: 'claude', agentName: 'Claude Agent', sessionId: 's1' } });
		await resumed.runner.send(request());
		assert.deepStrictEqual(resumed.sessions.calls, ['resume:s1']);
		assert.strictEqual(resumed.messages.filter(m => m.role === 'assistant' && m.notice).length, 0);

		const forgotten = setup({ binding: { agentId: 'claude', agentName: 'Claude Agent', sessionId: 's1' } });
		forgotten.sessions.resumeMode = 'new';
		await forgotten.runner.send(request());
		assert.deepStrictEqual(
			[forgotten.messages.filter(m => m.role === 'assistant' && m.notice).length, forgotten.thread.acpAgent?.sessionId],
			[1, 's2']);
	});

	test('агента нет в реестре — ход не стартует, причина названа в состоянии чата', async () => {
		const { runner, sessions, streamStates } = setup({ agents: [] });
		await runner.send(request());
		const last = streamStates[streamStates.length - 1];
		assert.deepStrictEqual([sessions.calls, last?.error?.message.includes('больше нет в .vibe/agents.json')], [[], true]);
	});

	test('новое сообщение посреди хода останавливает прошлый ход агента, а потом отправляется', async () => {
		const { runner, sessions, messages } = setup();
		sessions.script = () => new Promise<void>(resolve => { sessions.release = resolve; });
		const first = runner.send(request('долго'));
		await new Promise(resolve => setTimeout(resolve, 20));
		sessions.script = async () => { sessions.log.appendText('Ответ на второе', false); };
		await runner.send(request('второе'));
		await first;
		assert.deepStrictEqual([sessions.cancels, roles(messages)], [['s1'], ['user', 'user', 'assistant:Ответ на второе']]);
	});

	test('отказ и предел шагов называются в треде, обычный конец и остановка человеком — нет', async () => {
		const stopped = setup();
		stopped.sessions.script = async () => { stopped.sessions.lastStopReason = 'cancelled'; };
		await stopped.runner.send(request());
		const refused = setup();
		refused.sessions.script = async () => { refused.sessions.lastStopReason = 'refusal'; };
		await refused.runner.send(request());
		const limited = setup();
		limited.sessions.script = async () => { limited.sessions.lastStopReason = 'max_turns'; };
		await limited.runner.send(request());
		assert.deepStrictEqual([roles(stopped.messages), roles(refused.messages), roles(limited.messages)], [
			['user'],
			['user', 'assistant:Агент «Claude Agent» отказался выполнять задачу.'],
			['user', 'assistant:Агент «Claude Agent» упёрся в предел шагов.'],
		]);
	});

	test('ошибка хода уходит в состояние чата, а не в сообщение', async () => {
		const { runner, sessions, streamStates } = setup();
		sessions.script = async () => { sessions.error = 'связь оборвалась'; };
		await runner.send(request());
		const last = streamStates[streamStates.length - 1];
		assert.strictEqual(last?.error?.message, 'связь оборвалась');
	});

	test('режим треда выставляется сессии перед каждым ходом, а смена режима доходит до живой сессии сразу', async () => {
		const { runner, sessions, thread } = setup({ binding: { agentId: 'claude', agentName: 'Claude Agent', mode: 'edits' } });
		await runner.send(request());
		thread.acpAgent = { ...thread.acpAgent!, mode: 'plan' };
		await runner.applyMode('t1');
		assert.deepStrictEqual(sessions.modes, ['edits', 'plan']);
	});

	test('закрытие вкладки гасит процесс агента, а сессию тред помнит', async () => {
		const { runner, sessions, thread } = setup();
		await runner.send(request());
		await runner.release('t1');
		assert.deepStrictEqual([sessions.calls, thread.acpAgent?.sessionId], [['start', 'end:s1'], 's1']);
	});
});
