/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { deepClone } from '../../../../../base/common/objects.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
// The channel and the send path live in electron-main but are plain Node — the Node runner is where they run.
// They are imported in `suiteSetup`, after the renderer skip: statically, the renderer fails to resolve a package
// subpath of the send path and the whole Electron run stops at load.
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import type * as ChannelModule from '../../electron-main/sendLLMMessageChannel.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import type * as SendModule from '../../electron-main/llmMessage/sendLLMMessage.js';
import { skipInElectronRenderer } from './nodeOnly.js';
import type { IMetricsService } from '../../common/metricsService.js';
import type { AbortRef, MainSendLLMMessageParams } from '../../common/sendLLMMessageTypes.js';
import { defaultSettingsOfProvider, SettingsOfProvider } from '../../common/vibeideSettingsTypes.js';

/**
 * Отмена обязана обрывать сам запрос к провайдеру.
 *
 * Главный процесс ждал конца всего ответа, прежде чем вызвать обрыв, — и провайдер дописывал и выставлял
 * к оплате ответ, который уже никто не читал. Сервер здесь отвечает через паузу и только тому, кто ещё на
 * связи: соединение, закрытое до ответа, и есть признак настоящей отмены.
 */
suite('Отмена запроса к модели — обрыв соединения, а не ожидание конца ответа', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const ANSWER_AFTER_MS = 1500;
	let server: Server;
	let port = 0;
	const calls: { closed: boolean; answered: boolean }[] = [];

	let LLMMessageChannel: typeof ChannelModule.LLMMessageChannel;
	let sendLLMMessage: typeof SendModule.sendLLMMessage;

	suiteSetup(async function () {
		skipInElectronRenderer(this);
		({ LLMMessageChannel } = await import('../../electron-main/sendLLMMessageChannel.js'));
		({ sendLLMMessage } = await import('../../electron-main/llmMessage/sendLLMMessage.js'));
		const { createServer } = await import('http');
		server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const call = { closed: false, answered: false };
			calls.push(call);
			res.on('close', () => {
				if (!res.writableEnded) {
					call.closed = true;
				}
			});
			req.resume();
			setTimeout(() => {
				if (call.closed) {
					return;
				}
				call.answered = true;
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'поздно' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
			}, ANSWER_AFTER_MS);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
		port = (server.address() as AddressInfo).port;
	});

	suiteTeardown(async () => {
		// Skipped in the renderer before the server was made; mocha still runs the teardown.
		if (!server) {
			return;
		}
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	setup(() => {
		calls.length = 0;
	});

	const metrics = { capture: () => { } } as unknown as IMetricsService;

	type ChatRequest = Omit<Extract<MainSendLLMMessageParams, { messagesType: 'chatMessages' }>, 'requestId'>;
	const request = (): ChatRequest => {
		const settings = deepClone(defaultSettingsOfProvider) as unknown as Record<string, unknown>;
		settings['test-slow'] = { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'k', protocol: 'openai' };
		return {
			messagesType: 'chatMessages',
			messages: [{ role: 'user', content: 'привет' }],
			separateSystemMessage: undefined,
			chatMode: 'agent',
			logging: { loggingName: 'abort-test' },
			modelSelection: { providerName: 'test-slow' as ChatRequest['modelSelection']['providerName'], modelName: 'm' },
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
			settingsOfProvider: settings as unknown as SettingsOfProvider,
			mcpTools: undefined,
			runtimeOptions: { timeoutMs: { connection: 10_000, cloud: 15_000, aggregator: 15_000, streamIdle: 10_000, local: 10_000 } },
		};
	};

	const until = async (condition: () => boolean, withinMs: number) => {
		const deadline = Date.now() + withinMs;
		while (!condition() && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	};

	test('отмена во время ответа закрывает соединение сразу, а не после ответа', async function () {
		this.timeout(10_000);
		const channel = new LLMMessageChannel(metrics);
		await channel.call(undefined, 'sendLLMMessage', { ...request(), requestId: 'r1' });
		await until(() => calls.length === 1, 5000);
		await channel.call(undefined, 'abort', { requestId: 'r1' });
		await until(() => calls[0]?.closed === true, ANSWER_AFTER_MS / 2);
		assert.deepStrictEqual({ calls: calls.length, closed: calls[0]?.closed, answered: calls[0]?.answered }, { calls: 1, closed: true, answered: false });
	});

	test('отмена раньше, чем провайдер взвёл обрыв, всё равно не даёт ответу дойти', async function () {
		this.timeout(10_000);
		const abortRef: AbortRef = { current: null };
		let final = false;
		const done = sendLLMMessage({ ...request(), abortRef, onText: () => { }, onFinalMessage: () => { final = true; }, onError: () => { } }, metrics);
		// Synchronously, before the provider's own awaits let it arm its aborter.
		abortRef.current?.();
		await done;
		await new Promise(resolve => setTimeout(resolve, ANSWER_AFTER_MS + 300));
		assert.deepStrictEqual({ answered: calls.some(call => call.answered), final }, { answered: false, final: false });
	});
});
