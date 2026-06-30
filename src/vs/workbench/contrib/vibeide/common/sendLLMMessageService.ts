/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { sanitizeLlmErrorForLog } from './llmErrorSanitize.js';
import { EventLLMMessageOnTextParams, EventLLMMessageOnErrorParams, EventLLMMessageOnFinalMessageParams, ServiceSendLLMMessageParams, MainSendLLMMessageParams, MainLLMMessageAbortParams, ServiceModelListParams, EventModelListOnSuccessParams, EventModelListOnErrorParams, MainModelListParams, OllamaModelResponse, OpenaiCompatibleModelResponse, LLMChatMessage, AnthropicLLMChatMessage, OpenAILLMChatMessage, GeminiLLMChatMessage, } from './sendLLMMessageTypes.js';
import { IVibeTokenBudgetService } from './vibeTokenBudgetService.js';

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';
import { IMCPService } from './mcpService.js';
import { ISecretDetectionService } from './secretDetectionService.js';
import type { SecretMatch } from './secretDetection.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

// calls channel to implement features
export const ILLMMessageService = createDecorator<ILLMMessageService>('llmMessageService');

export interface ILLMMessageService {
	readonly _serviceBrand: undefined;
	sendLLMMessage: (params: ServiceSendLLMMessageParams) => string | null;
	abort: (requestId: string) => void;
	ollamaList: (params: ServiceModelListParams<OllamaModelResponse>) => void;
	openAICompatibleList: (params: ServiceModelListParams<OpenaiCompatibleModelResponse>) => void;
	/** Diagnostic: reset main-process transport (local client caches + shared cloud dispatcher) without restarting the IDE. */
	resetProviderClients: () => Promise<void>;
	/** Diagnostic: live shared-dispatcher generation/age (for the stall report). */
	getTransportDiagnostics: () => Promise<TransportDiagnostics>;
}

/** Live shared-dispatcher generation snapshot — see `getDispatcherDiagnostics` in systemCAFetch. */
export interface TransportDiagnostics {
	/** monotonic dispatcher generation; bumps on every (re)create */
	readonly id: number;
	/** how long the current pool has been reused, ms */
	readonly ageMs: number;
	readonly initialized: boolean;
}

/** Anthropic/OpenAI chat messages carry `content`; Gemini carries `parts`. */
function isContentMessage(msg: LLMChatMessage): msg is AnthropicLLMChatMessage | OpenAILLMChatMessage {
	return Object.hasOwn(msg, 'content');
}

/** Gemini chat messages carry `parts` instead of `content`. */
function isPartsMessage(msg: LLMChatMessage): msg is GeminiLLMChatMessage {
	return Object.hasOwn(msg, 'parts');
}

// open this file side by side with llmMessageChannel
export class LLMMessageService extends Disposable implements ILLMMessageService {

	readonly _serviceBrand: undefined;
	private readonly channel: IChannel; // LLMMessageChannel

	// sendLLMMessage
	private readonly llmMessageHooks: {
		onText: { [eventId: string]: ((params: EventLLMMessageOnTextParams) => void) };
		onFinalMessage: { [eventId: string]: ((params: EventLLMMessageOnFinalMessageParams) => void) };
		onError: { [eventId: string]: ((params: EventLLMMessageOnErrorParams) => void) };
		onAbort: { [eventId: string]: (() => void) };
	} = {
			onText: {},
			onFinalMessage: {},
			onError: {},
			onAbort: {}, // NOT sent over the channel, result is instant when we call .abort()
		};

	// list hooks
	private readonly listHooks: {
		ollama: {
			success: { [eventId: string]: ((params: EventModelListOnSuccessParams<OllamaModelResponse>) => void) };
			error: { [eventId: string]: ((params: EventModelListOnErrorParams<OllamaModelResponse>) => void) };
		};
		openAICompat: {
			success: { [eventId: string]: ((params: EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>) => void) };
			error: { [eventId: string]: ((params: EventModelListOnErrorParams<OpenaiCompatibleModelResponse>) => void) };
		};
	} = {
			ollama: {
				success: {},
				error: {},
			},
			openAICompat: {
				success: {},
				error: {},
			}
		};

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService, // used as a renderer (only usable on client side)
		@IVibeideSettingsService private readonly vibeideSettingsService: IVibeideSettingsService,
		@INotificationService private readonly notificationService: INotificationService,
		@IMCPService private readonly mcpService: IMCPService,
		@ISecretDetectionService private readonly secretDetectionService: ISecretDetectionService,
		@IVibeTokenBudgetService private readonly tokenBudgetService: IVibeTokenBudgetService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		// const service = ProxyChannel.toService<LLMMessageChannel>(mainProcessService.getChannel('vibe-channel-sendLLMMessage')); // lets you call it like a service
		// see llmMessageChannel.ts
		this.channel = this.mainProcessService.getChannel('vibeide-channel-llmMessage');

		// .listen sets up an IPC channel and takes a few ms, so we set up listeners immediately and add hooks to them instead
		// llm
		this._register((this.channel.listen('onText_sendLLMMessage') satisfies Event<EventLLMMessageOnTextParams>)(e => {
			this.llmMessageHooks.onText[e.requestId]?.(e);
		}));
		this._register((this.channel.listen('onFinalMessage_sendLLMMessage') satisfies Event<EventLLMMessageOnFinalMessageParams>)(e => {
			this.llmMessageHooks.onFinalMessage[e.requestId]?.(e);
			this._clearChannelHooks(e.requestId);
		}));
		this._register((this.channel.listen('onError_sendLLMMessage') satisfies Event<EventLLMMessageOnErrorParams>)(e => {
			this.llmMessageHooks.onError[e.requestId]?.(e);
			this._clearChannelHooks(e.requestId);
			// Mask secrets, then strip the echoed request body. AI SDK errors embed the FULL
			// prompt under requestBodyValues/messages; logging it verbatim leaks file contents
			// and non-pattern secrets and bloats the log (crash-report 2026-05-30). Pattern-secret
			// redaction stays; the bulk prompt payload is omitted.
			const config = this.secretDetectionService.getConfig();
			const errObj = config.enabled ? this.secretDetectionService.redactSecretsInObject(e).redacted : e;
			vibeLog.error('sendLLMMessage', 'Error in LLMMessageService:', sanitizeLlmErrorForLog(errObj));
		}));
		// .list()
		this._register((this.channel.listen('onSuccess_list_ollama') satisfies Event<EventModelListOnSuccessParams<OllamaModelResponse>>)(e => {
			this.listHooks.ollama.success[e.requestId]?.(e);
		}));
		this._register((this.channel.listen('onError_list_ollama') satisfies Event<EventModelListOnErrorParams<OllamaModelResponse>>)(e => {
			this.listHooks.ollama.error[e.requestId]?.(e);
		}));
		this._register((this.channel.listen('onSuccess_list_openAICompatible') satisfies Event<EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>>)(e => {
			this.listHooks.openAICompat.success[e.requestId]?.(e);
		}));
		this._register((this.channel.listen('onError_list_openAICompatible') satisfies Event<EventModelListOnErrorParams<OpenaiCompatibleModelResponse>>)(e => {
			this.listHooks.openAICompat.error[e.requestId]?.(e);
		}));

	}

	resetProviderClients(): Promise<void> {
		return this.channel.call('resetProviderClients');
	}

	getTransportDiagnostics(): Promise<TransportDiagnostics> {
		return this.channel.call('getTransportDiagnostics');
	}

	sendLLMMessage(params: ServiceSendLLMMessageParams) {
		const { onText, onFinalMessage, onError, onAbort, modelSelection, forceToolUse, ...proxyParams } = params;

		// VibeIDE: Enforce session token budget before sending
		try {
			this.tokenBudgetService.checkBudget();
		} catch (budgetError) {
			onError({ message: (budgetError as Error).message, fullError: budgetError });
			return null;
		}

		// throw an error if no model/provider selected (this should usually never be reached, the UI should check this first, but might happen in cases like Apply where we haven't built much UI/checks yet, good practice to have check logic on backend)
		if (modelSelection === null) {
			const message = `Please add a provider in VibeIDE Settings.`;
			onError({ message, fullError: null });
			return null;
		}

		if (params.messagesType === 'chatMessages' && (params.messages?.length ?? 0) === 0) {
			const message = `No messages detected.`;
			onError({ message, fullError: null });
			return null;
		}

		// Detect and redact secrets before sending
		const config = this.secretDetectionService.getConfig();
		if (config.enabled && params.messagesType === 'chatMessages' && params.messages) {
			const totalMatches: SecretMatch[] = [];
			let hasAnySecrets = false;

			// Scan all messages for secrets
			for (const msg of params.messages) {
				// Handle different message types
				if (isContentMessage(msg)) {
					// AnthropicLLMChatMessage or OpenAILLMChatMessage
					if (typeof msg.content === 'string') {
						const detection = this.secretDetectionService.detectSecrets(msg.content);
						if (detection.hasSecrets) {
							hasAnySecrets = true;
							totalMatches.push(...detection.matches);
							// Redact the message content
							msg.content = detection.redactedText;
						}
					} else if (Array.isArray(msg.content)) {
						// Handle array content (e.g., OpenAI format with images)
						for (const part of msg.content) {
							if (Object.hasOwn(part, 'type') && (part as { type?: string }).type === 'text' && Object.hasOwn(part, 'text')) {
								const textPart = part as { type: 'text'; text: string };
								if (typeof textPart.text === 'string') {
									const detection = this.secretDetectionService.detectSecrets(textPart.text);
									if (detection.hasSecrets) {
										hasAnySecrets = true;
										totalMatches.push(...detection.matches);
										textPart.text = detection.redactedText;
									}
								}
							}
						}
					}
				} else if (isPartsMessage(msg)) {
					// GeminiLLMChatMessage - uses 'parts' instead of 'content'
					for (const part of msg.parts) {
						if (Object.hasOwn(part, 'text')) {
							const textPart = part as { text: string };
							if (typeof textPart.text === 'string') {
								const detection = this.secretDetectionService.detectSecrets(textPart.text);
								if (detection.hasSecrets) {
									hasAnySecrets = true;
									totalMatches.push(...detection.matches);
									textPart.text = detection.redactedText;
								}
							}
						}
					}
				}
			}

			// Log secret detection result (trace) for verification that paths are not falsely redacted as AWS Secret Key
			const countByType = new Map<string, number>();
			for (const match of totalMatches) {
				const name = match.pattern.name;
				countByType.set(name, (countByType.get(name) || 0) + 1);
			}
			const typesList = Array.from(countByType.entries())
				.map(([name, count]) => `${name}=${count}`)
				.join(', ');
			vibeLog.trace('sendLLMMessage', '[SecretDetection] Chat messages scanned.', hasAnySecrets ? `Redacted: ${typesList}` : 'No secrets detected (paths in system message are not redacted).');

			// Show warning if secrets detected
			if (hasAnySecrets) {
				const typesListForUser = Array.from(countByType.entries())
					.map(([name, count]) => `${name} (${count})`)
					.join(', ');

				if (config.mode === 'block') {
					// Always show block notifications (they're important)
					this.notificationService.warn(
						`Secret detected: ${typesListForUser}. Message blocked from sending. Use environment variables or secure vaults instead of pasting keys into chat.`
					);
					onError({
						message: `Message blocked: Secrets detected (${typesListForUser}). Please remove secrets before sending.`,
						fullError: null,
					});
					return null;
				} else {
					// Redact mode - silently redact without notification
					// (Notification removed per user request)
				}
			}
		}

		const { settingsOfProvider, } = this.vibeideSettingsService.state;

		const mcpTools = this.mcpService.getMCPTools();

		let approxInputTokens = 1000;
		if (proxyParams.messagesType === 'chatMessages' && proxyParams.messages) {
			try {
				const msgsLen = JSON.stringify(proxyParams.messages).length;
				const sysExtra = (proxyParams.separateSystemMessage?.length ?? 0);
				approxInputTokens = Math.max(200, Math.ceil(msgsLen / 4) + Math.ceil(sysExtra / 4));
			} catch {
				approxInputTokens = 2000;
			}
		} else if (proxyParams.messagesType === 'FIMMessage') {
			const m = proxyParams.messages;
			approxInputTokens = Math.max(200, Math.ceil((m.prefix.length + m.suffix.length) / 4));
		}

		// add state for request id
		const requestId = generateUuid();
		this.llmMessageHooks.onText[requestId] = onText;
		this.llmMessageHooks.onFinalMessage[requestId] = (p) => {
			// Prefer real provider usage when available (AI SDK exposes promptTokens /
			// completionTokens via `finish` parts). Fall back to length/4 heuristic
			// when usage is missing (early-timeout, non-AI-SDK paths).
			const realIn = p.usage?.promptTokens;
			const realOut = p.usage?.completionTokens;
			const inForBudget = typeof realIn === 'number' && realIn > 0 ? realIn : approxInputTokens;
			let outForBudget: number;
			if (typeof realOut === 'number' && realOut > 0) {
				outForBudget = realOut;
			} else {
				const outChars = (p.fullText?.length ?? 0) + (p.fullReasoning?.length ?? 0);
				outForBudget = Math.max(1, Math.ceil(outChars / 4));
			}
			this.tokenBudgetService.recordUsage(inForBudget, outForBudget, p.usage?.cachedInputTokens);
			onFinalMessage(p);
		};
		this.llmMessageHooks.onError[requestId] = onError;
		this.llmMessageHooks.onAbort[requestId] = onAbort; // used internally only

		// Pull tunable timeouts from VS Code config (registered in vibeideGlobalSettingsConfiguration).
		// Reading per-call is cheap and lets users change the values without restart.
		// Backward-compat: if user has legacy `assumeNativeTools=false` and hasn't
		// touched the new `toolFallbackMode`, synthesize `'xml'` so existing
		// settings keep working. New setting wins if both are set.
		const newMode = this.configurationService.getValue<'auto' | 'native' | 'xml' | undefined>('vibeide.llm.toolFallbackMode');
		const oldAssumeNative = this.configurationService.getValue<boolean | undefined>('vibeide.llm.assumeNativeTools');
		const toolFallbackMode: 'auto' | 'native' | 'xml' = (() => {
			if (newMode === 'native' || newMode === 'xml') { return newMode; }
			// newMode is 'auto' or undefined → check legacy boolean for backward compat
			if (oldAssumeNative === false) { return 'xml'; }
			return 'auto';
		})();
		const runtimeOptions = {
			timeoutMs: {
				local: this.configurationService.getValue<number>('vibeide.llm.timeoutMs.local'),
				cloud: this.configurationService.getValue<number>('vibeide.llm.timeoutMs.cloud'),
				aggregator: this.configurationService.getValue<number>('vibeide.llm.timeoutMs.aggregator'),
				streamIdle: this.configurationService.getValue<number>('vibeide.llm.timeoutMs.streamIdle'),
				connection: this.configurationService.getValue<number>('vibeide.llm.timeoutMs.connection'),
			},
			assumeNativeTools: oldAssumeNative, // kept for legacy code paths
			toolFallbackMode,
			forceToolUse, // per-turn: agent loop forces tool_choice on the corrective nudge
		};

		// Transiently overlay dynamic-provider transport configs (.vibe/providers.json) so a dynamic
		// providerName resolves to a baseURL/apiKey/headers in electron-main. Not persisted — a local
		// copy made only for this send; persisted `settingsOfProvider` stays free of dynamic ids.
		const dynamicTransport = this.vibeideSettingsService.getDynamicTransportConfigs();
		const settingsOfProviderForSend = (Object.keys(dynamicTransport).length > 0
			? { ...settingsOfProvider, ...dynamicTransport }
			: settingsOfProvider) as typeof settingsOfProvider;

		// params will be stripped of all its functions over the IPC channel
		this.channel.call('sendLLMMessage', {
			...proxyParams,
			requestId,
			settingsOfProvider: settingsOfProviderForSend,
			modelSelection,
			mcpTools,
			runtimeOptions,
		} satisfies MainSendLLMMessageParams);

		return requestId;
	}

	abort(requestId: string) {
		this.llmMessageHooks.onAbort[requestId]?.(); // calling the abort hook here is instant (doesn't go over a channel)
		this.channel.call('abort', { requestId } satisfies MainLLMMessageAbortParams);
		this._clearChannelHooks(requestId);
	}


	ollamaList = (params: ServiceModelListParams<OllamaModelResponse>) => {
		const { onSuccess, onError, ...proxyParams } = params;

		const { settingsOfProvider } = this.vibeideSettingsService.state;

		// add state for request id
		const requestId_ = generateUuid();
		this.listHooks.ollama.success[requestId_] = onSuccess;
		this.listHooks.ollama.error[requestId_] = onError;

		this.channel.call('ollamaList', {
			...proxyParams,
			settingsOfProvider,
			providerName: 'ollama',
			requestId: requestId_,
		} satisfies MainModelListParams<OllamaModelResponse>);
	};


	openAICompatibleList = (params: ServiceModelListParams<OpenaiCompatibleModelResponse>) => {
		const { onSuccess, onError, ...proxyParams } = params;

		const { settingsOfProvider } = this.vibeideSettingsService.state;

		// add state for request id
		const requestId_ = generateUuid();
		this.listHooks.openAICompat.success[requestId_] = onSuccess;
		this.listHooks.openAICompat.error[requestId_] = onError;

		this.channel.call('openAICompatibleList', {
			...proxyParams,
			settingsOfProvider,
			requestId: requestId_,
		} satisfies MainModelListParams<OpenaiCompatibleModelResponse>);
	};

	private _clearChannelHooks(requestId: string) {
		delete this.llmMessageHooks.onText[requestId];
		delete this.llmMessageHooks.onFinalMessage[requestId];
		delete this.llmMessageHooks.onError[requestId];

		delete this.listHooks.ollama.success[requestId];
		delete this.listHooks.ollama.error[requestId];

		delete this.listHooks.openAICompat.success[requestId];
		delete this.listHooks.openAICompat.error[requestId];
	}
}

registerSingleton(ILLMMessageService, LLMMessageService, InstantiationType.Eager);

