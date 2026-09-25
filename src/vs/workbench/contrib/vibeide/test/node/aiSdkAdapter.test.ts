/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { IncomingHttpHeaders, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { deepClone } from '../../../../../base/common/objects.js';
// The adapter lives in electron-main but is plain Node — undici, the AI SDK, no Electron API. The Electron unit
// runner loads tests into a renderer, where undici finds no Node internals (`markResourceTiming`, timer `unref`)
// and fails; the Node runner is the environment this code actually runs in.
// Imported in `suiteSetup`, after the renderer skip — statically, the renderer stops the whole Electron run at load.
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import type * as AdapterModule from '../../electron-main/llmMessage/aiSdkAdapter.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import type { SendChatParams_Internal } from '../../electron-main/llmMessage/sendLLMMessage.internalTypes.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import type * as SendModule from '../../electron-main/llmMessage/sendLLMMessage.js';
import type { IMetricsService } from '../../common/metricsService.js';
import type { LLMChatMessage } from '../../common/sendLLMMessageTypes.js';
import { defaultSettingsOfProvider, SettingsOfProvider } from '../../common/vibeideSettingsTypes.js';
import { setExternalProviders } from '../../common/modelCapabilities.js';
import { skipInElectronRenderer } from './nodeOnly.js';

/**
 * Встроенные провайдеры через AI SDK — против локального сервера, отдающего настоящие потоки вендоров.
 *
 * Проверяется то, что делает сама библиотека и чего нельзя увидеть по типам: что уходит в запрос
 * (модель, мышление, усилие, лимит вывода, `store`, ключ кэша), как разбираются подписи рассуждения,
 * отказ классификатора и обрыв по лимиту посреди вызова инструмента, откуда берётся запись в кэш и
 * пауза Google, что повтор без потока спрашивает модель о том же и как выключается рассуждение по полю
 * файла провайдера. Сеть наружу не нужна, ключи не нужны.
 */

type WireBody = { readonly [key: string]: unknown };
type RecordedRequest = { readonly path: string; readonly headers: IncomingHttpHeaders; readonly body: WireBody | undefined };
type FinalMessage = Parameters<SendChatParams_Internal['onFinalMessage']>[0];
type ErrorMessage = Parameters<SendChatParams_Internal['onError']>[0];
type Outcome = { final?: FinalMessage; error?: ErrorMessage };

const sse = (events: readonly WireBody[], named: boolean): string =>
	events.map(event => `${named ? `event: ${String(event.type)}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('');

const anthropicStart = (model: string) => ({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_creation_input_tokens: 30, cache_read_input_tokens: 50 } } });

function anthropicStream(model: string): string {
	if (model.endsWith('-refusal')) {
		return sse([
			anthropicStart(model),
			{ type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'bio', explanation: 'Запрос похож на двойное назначение.' } }, usage: { output_tokens: 0 } },
			{ type: 'message_stop' },
		], true);
	}
	if (model.endsWith('-cut')) {
		return sse([
			anthropicStart(model),
			{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Пишу файл.' } },
			{ type: 'content_block_stop', index: 0 },
			{ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_cut', name: 'rewrite_file', input: {} } },
			{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"uri": "/a.ts", "new_content": "const a = 1;\\nconst' } },
			{ type: 'content_block_stop', index: 1 },
			{ type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 64000 } },
			{ type: 'message_stop' },
		], true);
	}
	return sse([
		anthropicStart(model),
		{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Проверю файл.' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-new' } },
		{ type: 'content_block_stop', index: 0 },
		{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Читаю.' } },
		{ type: 'content_block_stop', index: 1 },
		{ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } },
		{ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"uri": "/a.ts"}' } },
		{ type: 'content_block_stop', index: 2 },
		{ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } },
		{ type: 'message_stop' },
	], true);
}

const responsesStream = (model: string): string => sse([
	{ type: 'response.created', response: { id: 'resp_1', created_at: 1758600000, model } },
	{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
	{ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Готово.' },
	{ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
	{ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 2 } } } },
], false);

const compatibleStream = (): string => sse([
	{ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'Привет' }, finish_reason: null }] },
	{ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 40 } } },
], false) + 'data: [DONE]\n\n';

const unverifiedOrganisation = JSON.stringify({ error: { message: 'Your organization must be verified to stream this model. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization.', type: 'invalid_request_error', param: 'stream', code: 'unsupported_value' } });

const wholeChatCompletion = JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'o3', choices: [{ index: 0, message: { role: 'assistant', content: 'Готово без потока.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 6, total_tokens: 86 } });

const googleRateLimit = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted.', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '57.62s' }] } });

function respond(path: string, body: WireBody | undefined, res: ServerResponse): void {
	const model = String(body?.model ?? '');
	if (path === '/v1/messages') {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.end(anthropicStream(model));
	} else if (path === '/v1/responses') {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.end(responsesStream(model));
	} else if (path === '/v1/chat/completions') {
		// OpenAI will not STREAM a reasoning model to an organisation it has not verified; unstreamed, it answers.
		const streamed = body?.stream === true;
		res.writeHead(streamed ? 400 : 200, { 'content-type': 'application/json' });
		res.end(streamed ? unverifiedOrganisation : wholeChatCompletion);
	} else if (path === '/compat/v1/chat/completions') {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.end(compatibleStream());
	} else if (path.startsWith('/v1beta/models/')) {
		res.writeHead(429, { 'content-type': 'application/json' });
		res.end(googleRateLimit);
	} else {
		res.writeHead(404);
		res.end();
	}
}

suite('aiSdkAdapter — встроенные провайдеры против настоящих потоков вендоров', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let server: Server;
	let port = 0;
	const requests: RecordedRequest[] = [];
	const savedEnv = { anthropic: process.env.ANTHROPIC_BASE_URL, openai: process.env.OPENAI_BASE_URL };

	let sendViaAISdk: typeof AdapterModule.sendViaAISdk;
	let sendLLMMessage: typeof SendModule.sendLLMMessage;

	suiteSetup(async function () {
		skipInElectronRenderer(this);
		({ sendViaAISdk } = await import('../../electron-main/llmMessage/aiSdkAdapter.js'));
		({ sendLLMMessage } = await import('../../electron-main/llmMessage/sendLLMMessage.js'));
		const { createServer } = await import('http');
		server = createServer((req, res) => {
			let raw = '';
			req.on('data', chunk => { raw += chunk; });
			req.on('end', () => {
				const body = raw ? JSON.parse(raw) as WireBody : undefined;
				requests.push({ path: req.url ?? '', headers: req.headers, body });
				// Routed by path alone: a file provider's query parameters ride on the address
				respond((req.url ?? '').split('?')[0], body, res);
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
		port = (server.address() as AddressInfo).port;
		// Written for the official Anthropic client, without the version segment: the route must add it back.
		process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
		process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
	});

	suiteTeardown(async () => {
		process.env.ANTHROPIC_BASE_URL = savedEnv.anthropic;
		process.env.OPENAI_BASE_URL = savedEnv.openai;
		if (savedEnv.anthropic === undefined) { delete process.env.ANTHROPIC_BASE_URL; }
		if (savedEnv.openai === undefined) { delete process.env.OPENAI_BASE_URL; }
		// Skipped in the renderer before the server was made; mocha still runs the teardown.
		if (server) {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	setup(() => { requests.length = 0; });

	const settingsWith = (patch: Record<string, unknown>): SettingsOfProvider => {
		const settings = deepClone(defaultSettingsOfProvider) as unknown as Record<string, unknown>;
		for (const [id, value] of Object.entries(patch)) {
			settings[id] = { ...(settings[id] as object | undefined), ...(value as object) };
		}
		return settings as unknown as SettingsOfProvider;
	};

	const send = (params: Pick<SendChatParams_Internal, 'providerName' | 'modelName' | 'settingsOfProvider' | 'messages'> & Partial<SendChatParams_Internal>): Promise<Outcome> =>
		new Promise<Outcome>(resolve => {
			void sendViaAISdk({
				onText: () => { },
				onFinalMessage: final => resolve({ final }),
				onError: error => resolve({ error }),
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				_setAborter: () => { },
				separateSystemMessage: 'Ты агент.',
				chatMode: 'agent',
				mcpTools: undefined,
				runtimeOptions: { timeoutMs: { connection: 10_000, cloud: 15_000, aggregator: 15_000, streamIdle: 10_000, local: 10_000 } },
				...params,
			});
		});

	const history: LLMChatMessage[] = [
		{ role: 'user', content: 'Прочитай файл' },
		{
			role: 'assistant', content: [
				{ type: 'thinking', thinking: 'Сначала найду файл.', signature: 'sig-prev' },
				{ type: 'text', text: 'Ищу.' },
				{ type: 'tool_use', id: 'toolu_0', name: 'ls_dir', input: { uri: '/' } },
			],
		},
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'a.ts' }] },
	];

	test('Anthropic: запрос несёт модель, мышление, уровень и лимит; ответ — подписанный блок, вызов и расход', async () => {
		const outcome = await send({
			providerName: 'anthropic',
			modelName: 'claude-opus-5-5',
			settingsOfProvider: settingsWith({ anthropic: { apiKey: 'sk-ant-test' } }),
			modelSelectionOptions: { reasoningEnabled: true, reasoningEffort: 'high' },
			messages: history,
		});
		const request = requests.find(r => r.path === '/v1/messages');
		const assistant = (request?.body?.messages as ReadonlyArray<{ role: string; content: ReadonlyArray<WireBody> }> | undefined)?.find(m => m.role === 'assistant');
		assert.deepStrictEqual({
			apiKey: request?.headers['x-api-key'],
			// The SDK sends betas of its own; the old tool-streaming and interleaving flags must not travel to Anthropic.
			legacyBetas: /fine-grained-tool-streaming|interleaved-thinking/.test(String(request?.headers['anthropic-beta'] ?? '')),
			model: request?.body?.model,
			maxTokens: request?.body?.max_tokens,
			thinking: request?.body?.thinking,
			outputConfig: request?.body?.output_config,
			replayedThinking: assistant?.content[0],
		}, {
			apiKey: 'sk-ant-test',
			legacyBetas: false,
			model: 'claude-opus-5-5',
			maxTokens: 64_000,
			thinking: { type: 'adaptive', display: 'summarized' },
			outputConfig: { effort: 'high' },
			replayedThinking: { type: 'thinking', thinking: 'Сначала найду файл.', signature: 'sig-prev' },
		});
		assert.deepStrictEqual({
			error: outcome.error?.message,
			text: outcome.final?.fullText,
			reasoning: outcome.final?.fullReasoning,
			anthropicReasoning: outcome.final?.anthropicReasoning,
			toolCall: outcome.final?.toolCall && { name: outcome.final.toolCall.name, rawParams: outcome.final.toolCall.rawParams, isDone: outcome.final.toolCall.isDone },
			cached: outcome.final?.usage?.cachedInputTokens,
			cacheWrites: outcome.final?.usage?.cacheWriteTokens,
			output: outcome.final?.usage?.completionTokens,
			notice: outcome.final?.finishNotice,
		}, {
			error: undefined,
			text: 'Читаю.',
			reasoning: 'Проверю файл.',
			anthropicReasoning: [{ type: 'thinking', thinking: 'Проверю файл.', signature: 'sig-new' }],
			toolCall: { name: 'read_file', rawParams: { uri: '/a.ts' }, isDone: true },
			cached: 50,
			cacheWrites: 30,
			output: 42,
			notice: undefined,
		});
	});

	test('Anthropic: отказ классификатора без текста — ошибка с категорией, а не «пустой ответ»', async () => {
		const outcome = await send({
			providerName: 'anthropic',
			modelName: 'claude-opus-5-5-refusal',
			settingsOfProvider: settingsWith({ anthropic: { apiKey: 'sk-ant-test' } }),
			messages: [{ role: 'user', content: 'Вопрос' }],
		});
		assert.deepStrictEqual([outcome.final, outcome.error?.message], [
			undefined,
			'Модель claude-opus-5-5-refusal отказалась отвечать: сработал фильтр безопасности вендора (bio). Запрос похож на двойное назначение.',
		]);
	});

	test('Anthropic: обрыв по лимиту посреди вызова — текст отдан, вызов не выполняется, названо почему', async () => {
		const outcome = await send({
			providerName: 'anthropic',
			modelName: 'claude-opus-5-5-cut',
			settingsOfProvider: settingsWith({ anthropic: { apiKey: 'sk-ant-test' } }),
			messages: [{ role: 'user', content: 'Перепиши файл' }],
		});
		assert.deepStrictEqual({ text: outcome.final?.fullText, toolCall: outcome.final?.toolCall, notice: outcome.final?.finishNotice, error: outcome.error?.message }, {
			text: 'Пишу файл.',
			toolCall: undefined,
			notice: { kind: 'truncated', by: 'output-limit', cutToolName: 'rewrite_file' },
			error: undefined,
		});
	});

	test('OpenAI: GPT-6 уходит в Responses — усилие, «выключено» как none, store:false, ключ кэша', async () => {
		const settings = settingsWith({ openAI: { apiKey: 'sk-test', promptCacheKey: true } });
		const on = await send({ providerName: 'openAI', modelName: 'gpt-6-luna', settingsOfProvider: settings, modelSelectionOptions: { reasoningEnabled: true }, messages: [{ role: 'user', content: 'Сделай' }], runtimeOptions: { promptCacheKey: 'vibe-abc' } });
		const off = await send({ providerName: 'openAI', modelName: 'gpt-6-luna', settingsOfProvider: settings, modelSelectionOptions: { reasoningEnabled: false }, messages: [{ role: 'user', content: 'Сделай' }] });
		const [first, second] = requests.filter(r => r.path === '/v1/responses');
		assert.deepStrictEqual({
			paths: requests.map(r => r.path),
			reasoning: [first?.body?.reasoning, second?.body?.reasoning],
			store: first?.body?.store,
			cacheKey: first?.body?.prompt_cache_key,
			hasTools: Array.isArray(first?.body?.tools) && (first.body.tools as unknown[]).length > 0,
			text: [on.final?.fullText, off.final?.fullText],
			input: on.final?.usage?.promptTokens,
		}, {
			paths: ['/v1/responses', '/v1/responses'],
			reasoning: [{ effort: 'medium' }, { effort: 'none' }],
			store: false,
			cacheKey: 'vibe-abc',
			hasTools: true,
			text: ['Готово.', 'Готово.'],
			input: 100,
		});
	});

	test('OpenAI: организации без верификации поток запрещён — тот же запрос уходит ещё раз целиком', async () => {
		const outcome = await send({
			providerName: 'openAI',
			modelName: 'o3',
			settingsOfProvider: settingsWith({ openAI: { apiKey: 'sk-test' } }),
			modelSelectionOptions: { reasoningEnabled: true, reasoningEffort: 'high' },
			messages: [{ role: 'user', content: 'Сделай' }],
		});
		const [streamed, whole] = requests.filter(r => r.path === '/v1/chat/completions');
		// Everything but the transport: the repeat must ask the model the same thing.
		const withoutTransport = (body: WireBody | undefined) => Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => key !== 'stream' && key !== 'stream_options'));
		assert.deepStrictEqual({
			paths: requests.map(r => r.path),
			stream: [streamed?.body?.stream, whole?.body?.stream],
			effort: streamed?.body?.reasoning_effort,
			repeat: withoutTransport(whole?.body),
			text: outcome.final?.fullText,
			output: outcome.final?.usage?.completionTokens,
			error: outcome.error?.message,
		}, {
			paths: ['/v1/chat/completions', '/v1/chat/completions'],
			stream: [true, undefined],
			effort: 'high',
			repeat: withoutTransport(streamed?.body),
			text: 'Готово без потока.',
			output: 6,
			error: undefined,
		});
	});

	test('совместимый провод: запись в кэш читается из prompt_tokens_details, которые библиотека пропускает', async () => {
		const outcome = await send({
			providerName: 'test-compat' as SendChatParams_Internal['providerName'],
			modelName: 'some-model',
			settingsOfProvider: settingsWith({ 'test-compat': { baseURL: `http://127.0.0.1:${port}/compat/v1`, apiKey: 'k', protocol: 'openai' } }),
			messages: [{ role: 'user', content: 'Привет' }],
		});
		assert.deepStrictEqual([outcome.final?.fullText, outcome.final?.usage?.cachedInputTokens, outcome.final?.usage?.cacheWriteTokens], ['Привет', 10, 40]);
	});

	test('совместимый провод: «выключено» уходит полем reasoning.off из файла провайдера, «включено» — усилием', async () => {
		// Registered the way the dynamic-providers service registers a file's provider: the off payload is a
		// capability of the model, read from its `reasoning.off`.
		setExternalProviders([{
			id: 'test-mimo', source: 'file', modelCapOverrides: {
				'mimo-v2.6': {
					reasoningCapabilities: {
						supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true,
						reasoningSlider: { type: 'effort_slider', values: ['low', 'high'], default: 'high' },
						reasoningOffPayload: { thinking: { type: 'disabled' } },
					},
				},
			},
		}]);
		try {
			const params = {
				providerName: 'test-mimo' as SendChatParams_Internal['providerName'],
				modelName: 'mimo-v2.6',
				settingsOfProvider: settingsWith({ 'test-mimo': { baseURL: `http://127.0.0.1:${port}/compat/v1`, apiKey: 'k', protocol: 'openai' } }),
				messages: [{ role: 'user', content: 'Привет' }] satisfies LLMChatMessage[],
			};
			await send({ ...params, modelSelectionOptions: { reasoningEnabled: false } });
			await send({ ...params, modelSelectionOptions: { reasoningEnabled: true, reasoningEffort: 'low' } });
		} finally {
			setExternalProviders([]);
		}
		const [off, on] = requests.filter(r => r.path === '/compat/v1/chat/completions');
		assert.deepStrictEqual(
			{ off: [off?.body?.thinking, off?.body?.reasoning_effort], on: [on?.body?.thinking, on?.body?.reasoning_effort] },
			{ off: [{ type: 'disabled' }, undefined], on: [undefined, 'low'] },
		);
	});

	test('провайдер из файла через главный процесс: возможности модели доезжают, диалект OpenRouter пишет рассуждение объектом', async () => {
		// Shaped as the window sends it — the transport config under the provider's id, nothing registered by hand:
		// the file's model caps used to ride on the settings seed, which this config replaces, and never arrived.
		const reasoning = {
			supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true,
			reasoningSlider: { type: 'effort_slider', values: ['low', 'high'], default: 'high' },
		};
		const transport = (id: string, dialect: boolean) => ({
			baseURL: `http://127.0.0.1:${port}/compat/v1`, apiKey: 'k', protocol: 'openai',
			...(dialect ? { reasoningDialect: 'openrouter' } : {}),
			modelCapOverrides: { 'router-model': { reasoningCapabilities: reasoning, additionalOpenAIPayload: { route_hint: id } } },
		});
		const metrics = { capture: () => { } } as unknown as IMetricsService;
		const viaMain = (providerName: string, dialect: boolean, reasoningEnabled: boolean) => new Promise<void>(resolve => {
			void sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: 'Привет' }],
				separateSystemMessage: undefined,
				chatMode: 'agent',
				logging: { loggingName: 'dialect-test' },
				modelSelection: { providerName: providerName as SendChatParams_Internal['providerName'], modelName: 'router-model' },
				modelSelectionOptions: reasoningEnabled ? { reasoningEnabled: true, reasoningEffort: 'low' } : { reasoningEnabled: false },
				overridesOfModel: undefined,
				settingsOfProvider: settingsWith({ [providerName]: transport(providerName, dialect) }),
				mcpTools: undefined,
				runtimeOptions: { timeoutMs: { connection: 10_000, cloud: 15_000, aggregator: 15_000, streamIdle: 10_000, local: 10_000 } },
				abortRef: { current: null },
				onText: () => { },
				onFinalMessage: () => resolve(),
				onError: () => resolve(),
			}, metrics);
		});
		try {
			await viaMain('test-router', true, false);
			await viaMain('test-router', true, true);
			await viaMain('test-plain', false, true);
		} finally {
			setExternalProviders([]);
		}
		const bodies = requests.filter(r => r.path === '/compat/v1/chat/completions').map(r => r.body);
		assert.deepStrictEqual(bodies.map(b => ({ reasoning: b?.reasoning, reasoningEffort: b?.reasoning_effort, routeHint: b?.route_hint })), [
			{ reasoning: { effort: 'none' }, reasoningEffort: undefined, routeHint: 'test-router' },
			{ reasoning: { effort: 'low' }, reasoningEffort: undefined, routeHint: 'test-router' },
			{ reasoning: undefined, reasoningEffort: 'low', routeHint: 'test-plain' },
		]);
	});

	test('сервер без ключа (auth: "none"): ни на одном проводе ключа нет, ключ из окружения не подхватывается', async () => {
		// Every SDK reads its vendor's variable when handed no key: a keyless route that let it would carry the
		// user's real key to a server that asked for none.
		const canary = 'sk-canary-from-env';
		const envNames = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] as const;
		const savedKeys = envNames.map(name => process.env[name]);
		for (const name of envNames) { process.env[name] = canary; }
		const wires = [
			{ protocol: 'openai', base: '/compat/v1', path: '/compat/v1/chat/completions', model: 'local-model' },
			{ protocol: 'openai-responses', base: '/v1', path: '/v1/responses', model: 'local-model' },
			{ protocol: 'anthropic', base: '/v1', path: '/v1/messages', model: 'local-model' },
			{ protocol: 'gemini', base: '/v1beta', path: '/v1beta/models/', model: 'local-model' },
		];
		try {
			for (const wire of wires) {
				await send({
					providerName: 'test-keyless' as SendChatParams_Internal['providerName'],
					modelName: wire.model,
					settingsOfProvider: settingsWith({ 'test-keyless': { baseURL: `http://127.0.0.1:${port}${wire.base}`, protocol: wire.protocol, keyless: true, headers: { 'x-team': 'platform' } } }),
					messages: [{ role: 'user', content: 'Привет' }],
				});
			}
			await send({
				providerName: 'test-keyed' as SendChatParams_Internal['providerName'],
				modelName: 'local-model',
				settingsOfProvider: settingsWith({ 'test-keyed': { baseURL: `http://127.0.0.1:${port}/compat/v1`, apiKey: 'k', protocol: 'openai' } }),
				messages: [{ role: 'user', content: 'Привет' }],
			});
		} finally {
			envNames.forEach((name, i) => {
				if (savedKeys[i] === undefined) { delete process.env[name]; } else { process.env[name] = savedKeys[i]; }
			});
		}
		const seen = (path: string, nth: number) => {
			const request = requests.filter(r => r.path.startsWith(path))[nth];
			return {
				authorization: request?.headers['authorization'],
				xApiKey: request?.headers['x-api-key'],
				xGoogApiKey: request?.headers['x-goog-api-key'],
				team: request?.headers['x-team'],
			};
		};
		const keyless = { authorization: undefined, xApiKey: undefined, xGoogApiKey: undefined, team: 'platform' };
		assert.deepStrictEqual(
			[...wires.map(wire => seen(wire.path, 0)), seen('/compat/v1/chat/completions', 1)],
			[keyless, keyless, keyless, keyless, { authorization: 'Bearer k', xApiKey: undefined, xGoogApiKey: undefined, team: undefined }],
		);
	});

	test('ключ провайдера из файла: написанное — как написано, без auth — родной заголовок провода, без ключа — ничего', async () => {
		// One vendor may serve one key over two wires and read it from each wire's own header (OpenCode does): the SDK
		// puts nothing of its own, the key goes where `keyPlacement` puts it for THIS request's wire.
		const canary = 'sk-canary-from-env';
		const savedKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = canary;
		const via = (id: string, transport: Record<string, unknown>) => send({
			providerName: id as SendChatParams_Internal['providerName'],
			modelName: 'local-model',
			settingsOfProvider: settingsWith({ [id]: transport }),
			messages: [{ role: 'user', content: 'Привет' }],
		});
		const wires = [
			{ protocol: 'openai', base: '/compat/v1', path: '/compat/v1/chat/completions' },
			{ protocol: 'openai-responses', base: '/v1', path: '/v1/responses' },
			{ protocol: 'anthropic', base: '/v1', path: '/v1/messages' },
			{ protocol: 'gemini', base: '/v1beta', path: '/v1beta/models/' },
		];
		try {
			for (const wire of wires) {
				await via('file-native', { baseURL: `http://127.0.0.1:${port}${wire.base}`, protocol: wire.protocol, apiKey: 'k' });
			}
			await via('file-bearer', { baseURL: `http://127.0.0.1:${port}/v1`, protocol: 'anthropic', apiKey: 'k', auth: 'bearer' });
			await via('file-header', { baseURL: `http://127.0.0.1:${port}/v1`, protocol: 'anthropic', apiKey: 'k', auth: { type: 'header', name: 'api-key' } });
			await via('file-query', { baseURL: `http://127.0.0.1:${port}/compat/v1`, protocol: 'openai', apiKey: 'k', auth: { type: 'query', name: 'code' }, query: { 'api-version': '2025-01-01' } });
			await via('file-no-key', { baseURL: `http://127.0.0.1:${port}/compat/v1`, protocol: 'openai' });
		} finally {
			if (savedKey === undefined) { delete process.env.OPENAI_API_KEY; } else { process.env.OPENAI_API_KEY = savedKey; }
		}
		const seen = (path: string, nth: number) => {
			const request = requests.filter(r => r.path.startsWith(path))[nth];
			return {
				query: request?.path.split('?')[1],
				authorization: request?.headers['authorization'],
				xApiKey: request?.headers['x-api-key'],
				xGoogApiKey: request?.headers['x-goog-api-key'],
				apiKey: request?.headers['api-key'],
			};
		};
		const only = (headers: { authorization?: string; xApiKey?: string; xGoogApiKey?: string; apiKey?: string }, query?: string) =>
			({ query, authorization: undefined, xApiKey: undefined, xGoogApiKey: undefined, apiKey: undefined, ...headers });
		assert.deepStrictEqual([
			...wires.map(wire => seen(wire.path, 0)),
			seen('/v1/messages', 1),
			seen('/v1/messages', 2),
			seen('/compat/v1/chat/completions', 1),
			seen('/compat/v1/chat/completions', 2),
		], [
			only({ authorization: 'Bearer k' }),
			only({ authorization: 'Bearer k' }),
			only({ xApiKey: 'k' }),
			// `alt=sse` is the Gemini SDK's own: a streamed answer is asked for in the address
			only({ xGoogApiKey: 'k' }, 'alt=sse'),
			only({ authorization: 'Bearer k' }),
			only({ apiKey: 'k' }),
			only({}, 'api-version=2025-01-01&code=k'),
			only({}),
		]);
	});

	test('Google: пауза из RetryInfo становится retry-after, далёкая пауза не повторяется на месте и названа лимитом', async () => {
		const outcome = await send({
			providerName: 'test-gemini' as SendChatParams_Internal['providerName'],
			modelName: 'gemini-3-pro',
			settingsOfProvider: settingsWith({ 'test-gemini': { baseURL: `http://127.0.0.1:${port}/v1beta`, apiKey: 'g', protocol: 'gemini' } }),
			messages: [{ role: 'user', content: 'Привет' }],
		});
		const headers = (outcome.error?.fullError as { responseHeaders?: Record<string, string> } | null | undefined)?.responseHeaders;
		// «Rate limit» в сообщении — то, по чему чат включает паузу; слова Google о лимите не говорят.
		assert.deepStrictEqual(
			[requests.filter(r => r.path.startsWith('/v1beta/')).length, headers?.['retry-after'], outcome.error?.message, outcome.final],
			[1, '58', 'Rate limit exceeded: Resource has been exhausted.', undefined],
		);
	});
});
