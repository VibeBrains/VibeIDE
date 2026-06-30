/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// registered in app.ts
// code convention is to make a service responsible for this stuff, and not a channel, but having fewer files is simpler...

import { vibeLog } from '../common/vibeLog.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { EventLLMMessageOnTextParams, EventLLMMessageOnErrorParams, EventLLMMessageOnFinalMessageParams, MainSendLLMMessageParams, AbortRef, SendLLMMessageParams, MainLLMMessageAbortParams, ModelListParams, EventModelListOnSuccessParams, EventModelListOnErrorParams, OllamaModelResponse, OpenaiCompatibleModelResponse, MainModelListParams, } from '../common/sendLLMMessageTypes.js';
import { sendLLMMessage } from './llmMessage/sendLLMMessage.js';
import { IMetricsService } from '../common/metricsService.js';
import { sendLLMMessageToProviderImplementation, clearProviderClientCaches } from './llmMessage/sendLLMMessage.impl.js';
import { getDispatcherDiagnostics } from './llmMessage/systemCAFetch.js';

// NODE IMPLEMENTATION - calls actual sendLLMMessage() and returns listeners to it

export class LLMMessageChannel implements IServerChannel {

	// sendLLMMessage
	private readonly llmMessageEmitters = {
		onText: new Emitter<EventLLMMessageOnTextParams>(),
		onFinalMessage: new Emitter<EventLLMMessageOnFinalMessageParams>(),
		onError: new Emitter<EventLLMMessageOnErrorParams>(),
	};

	// aborters for above
	private readonly _infoOfRunningRequest: Record<string, { waitForSend: Promise<void> | undefined; abortRef: AbortRef }> = {};


	// list
	private readonly listEmitters = {
		ollama: {
			success: new Emitter<EventModelListOnSuccessParams<OllamaModelResponse>>(),
			error: new Emitter<EventModelListOnErrorParams<OllamaModelResponse>>(),
		},
		openaiCompat: {
			success: new Emitter<EventModelListOnSuccessParams<OpenaiCompatibleModelResponse>>(),
			error: new Emitter<EventModelListOnErrorParams<OpenaiCompatibleModelResponse>>(),
		},
	};

	// stupidly, channels can't take in @IService
	constructor(
		private readonly metricsService: IMetricsService,
	) { }

	// browser uses this to listen for changes
	listen<T>(_: unknown, event: string): Event<T> {
		// text
		let result: Event<unknown>;
		if (event === 'onText_sendLLMMessage') { result = this.llmMessageEmitters.onText.event; }
		else if (event === 'onFinalMessage_sendLLMMessage') { result = this.llmMessageEmitters.onFinalMessage.event; }
		else if (event === 'onError_sendLLMMessage') { result = this.llmMessageEmitters.onError.event; }
		// list
		else if (event === 'onSuccess_list_ollama') { result = this.listEmitters.ollama.success.event; }
		else if (event === 'onError_list_ollama') { result = this.listEmitters.ollama.error.event; }
		else if (event === 'onSuccess_list_openAICompatible') { result = this.listEmitters.openaiCompat.success.event; }
		else if (event === 'onError_list_openAICompatible') { result = this.listEmitters.openaiCompat.error.event; }

		else { throw new Error(`Event not found: ${event}`); }
		return result as Event<T>;
	}

	// browser uses this to call (see this.channel.call() in llmMessageService.ts for all usages)
	async call<T>(_: unknown, command: string, params: unknown): Promise<T> {
		try {
			if (command === 'sendLLMMessage') {
				this._callSendLLMMessage(params as MainSendLLMMessageParams);
			}
			else if (command === 'abort') {
				await this._callAbort(params as MainLLMMessageAbortParams);
			}
			else if (command === 'ollamaList') {
				this._callOllamaList(params as MainModelListParams<OllamaModelResponse>);
			}
			else if (command === 'openAICompatibleList') {
				this._callOpenAICompatibleList(params as MainModelListParams<OpenaiCompatibleModelResponse>);
			}
			else if (command === 'resetProviderClients') {
				// Diagnostic: clear stale local client caches + recreate the shared cloud
				// dispatcher so wedged transport recovers without an IDE restart.
				clearProviderClientCaches();
			}
			else if (command === 'getTransportDiagnostics') {
				// Diagnostic: live shared-dispatcher generation/age for the stall report.
				return getDispatcherDiagnostics() as T;
			}
			else {
				throw new Error(`VibeIDE sendLLM: command "${command}" not recognized.`);
			}
		}
		catch (e) {
			vibeLog.info('sendLLMMessageChannel', 'llmMessageChannel: Call Error:', e);
		}
		return undefined as T;
	}

	// the only place sendLLMMessage is actually called
	private _callSendLLMMessage(params: MainSendLLMMessageParams) {
		const { requestId } = params;

		if (!Object.hasOwn(this._infoOfRunningRequest, requestId)) { this._infoOfRunningRequest[requestId] = { waitForSend: undefined, abortRef: { current: null } }; }

		const mainThreadParams: SendLLMMessageParams = {
			...params,
			onText: (p) => {
				this.llmMessageEmitters.onText.fire({ requestId, ...p });
			},
			onFinalMessage: (p) => {
				this.llmMessageEmitters.onFinalMessage.fire({ requestId, ...p });
			},
			onError: (p) => {
				vibeLog.info('sendLLMMessageChannel', 'sendLLM: firing err');
				this.llmMessageEmitters.onError.fire({ requestId, ...p });
			},
			abortRef: this._infoOfRunningRequest[requestId].abortRef,
		};
		const p = sendLLMMessage(mainThreadParams, this.metricsService);
		this._infoOfRunningRequest[requestId].waitForSend = p;
	}

	private async _callAbort(params: MainLLMMessageAbortParams) {
		const { requestId } = params;
		if (!Object.hasOwn(this._infoOfRunningRequest, requestId)) { return; }
		const { waitForSend, abortRef } = this._infoOfRunningRequest[requestId];
		await waitForSend; // wait for the send to finish so we know abortRef was set
		abortRef?.current?.();
		delete this._infoOfRunningRequest[requestId];
	}





	_callOllamaList = (params: MainModelListParams<OllamaModelResponse>) => {
		const { requestId } = params;
		const emitters = this.listEmitters.ollama;
		const mainThreadParams: ModelListParams<OllamaModelResponse> = {
			...params,
			onSuccess: (p) => { emitters.success.fire({ requestId, ...p }); },
			onError: (p) => { emitters.error.fire({ requestId, ...p }); },
		};
		sendLLMMessageToProviderImplementation.ollama.list(mainThreadParams);
	};

	_callOpenAICompatibleList = (params: MainModelListParams<OpenaiCompatibleModelResponse>) => {
		const { requestId, providerName } = params;
		const emitters = this.listEmitters.openaiCompat;
		const mainThreadParams: ModelListParams<OpenaiCompatibleModelResponse> = {
			...params,
			onSuccess: (p) => { emitters.success.fire({ requestId, ...p }); },
			onError: (p) => { emitters.error.fire({ requestId, ...p }); },
		};
		sendLLMMessageToProviderImplementation[providerName].list(mainThreadParams);
	};





}
