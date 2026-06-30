/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../common/vibeLog.js';
import { SendLLMMessageParams, OnText, OnFinalMessage, OnError } from '../../common/sendLLMMessageTypes.js';
import { IMetricsService } from '../../common/metricsService.js';
import { displayInfoOfProviderName, FeatureName, providerNames } from '../../common/vibeideSettingsTypes.js';
import { setExternalProviders, ExternalProviderDescriptor, VibeideStaticModelInfo } from '../../common/modelCapabilities.js';
import { sendLLMMessageToProviderImplementation, dynamicProviderImplementation } from './sendLLMMessage.impl.js';

/**
 * Register dynamic providers (.vibe/providers.json) into THIS process's caps registry. The renderer's
 * registry doesn't cross the process boundary, but `settingsOfProvider` (carrying each dynamic provider's
 * seed entry + `modelCapOverrides`) does — per request. Without this, getModelCapabilities in the send
 * path can't recognize a dynamic model and sends no tools / wrong caps. Replace-all each call (cheap).
 */
const _builtinProviderSet = new Set<string>(providerNames as readonly string[]);
const syncExternalProvidersFromSettings = (settingsOfProvider: SendLLMMessageParams['settingsOfProvider']): void => {
	const descriptors: ExternalProviderDescriptor[] = [];
	const entries = settingsOfProvider as unknown as Record<string, { modelCapOverrides?: { [modelId: string]: Partial<VibeideStaticModelInfo> } } | undefined>;
	for (const id of Object.keys(entries)) {
		if (_builtinProviderSet.has(id)) { continue; }
		const entry = entries[id];
		if (!entry) { continue; }
		descriptors.push({ id, source: 'file', ...(entry.modelCapOverrides ? { modelCapOverrides: entry.modelCapOverrides } : {}) });
	}
	setExternalProviders(descriptors);
};


export const sendLLMMessage = async ({
	messagesType,
	messages: messages_,
	onText: onText_,
	onFinalMessage: onFinalMessage_,
	onError: onError_,
	abortRef: abortRef_,
	logging: { loggingName, loggingExtras },
	settingsOfProvider,
	modelSelection,
	modelSelectionOptions,
	overridesOfModel,
	chatMode,
	separateSystemMessage,
	mcpTools,
	runtimeOptions,
}: SendLLMMessageParams,

	metricsService: IMetricsService
) => {


	const { providerName, modelName } = modelSelection;

	// Sync dynamic providers into this process's caps registry before any getModelCapabilities call.
	syncExternalProvidersFromSettings(settingsOfProvider);

	// only captures number of messages and message "shape", no actual code, instructions, prompts, etc
	const captureLLMEvent = (eventId: string, extras?: object) => {


		metricsService.capture(eventId, {
			providerName,
			modelName,
			customEndpointURL: providerName !== 'auto' ? settingsOfProvider[providerName]?.endpoint : undefined,
			numModelsAtEndpoint: providerName !== 'auto' ? settingsOfProvider[providerName]?.models?.length : undefined,
			...messagesType === 'chatMessages' ? {
				numMessages: messages_?.length,
			} : messagesType === 'FIMMessage' ? {
				prefixLength: messages_.prefix.length,
				suffixLength: messages_.suffix.length,
			} : {},
			...loggingExtras,
			...extras,
		});
	};
	const submit_time = new Date();

	let _fullTextSoFar = '';
	let _aborter: (() => void) | null = null;
	const _setAborter = (fn: () => void) => { _aborter = fn; };
	let _didAbort = false;

	const onText: OnText = (params) => {
		const { fullText } = params;
		if (_didAbort) { return; }
		onText_(params);
		_fullTextSoFar = fullText;
	};

	const onFinalMessage: OnFinalMessage = (params) => {
		const { fullText, fullReasoning, toolCall } = params;
		if (_didAbort) { return; }
		captureLLMEvent(`${loggingName} - Received Full Message`, { messageLength: fullText.length, reasoningLength: fullReasoning?.length, duration: Date.now() - submit_time.getTime(), toolCallName: toolCall?.name });
		onFinalMessage_(params);
	};

	const onError: OnError = ({ message: errorMessage, fullError }) => {
		if (_didAbort) { return; }
		vibeLog.error('sendLLMMessage', 'sendLLMMessage onError:', errorMessage);

		// handle failed to fetch / connection errors, which give 0 information by design
		const isConnectionError = errorMessage === 'TypeError: fetch failed'
			|| errorMessage.includes('Connection error')
			|| errorMessage.startsWith('APIConnectionError');
		if (isConnectionError) {
			// Preserve the undici/Node diagnostic suffix produced by the impl layer
			// (e.g. "APIConnectionError: Connection error. [code=ECONNRESET host=opencode.ai:443]")
			// so the user-visible toast still tells us *why* we couldn't connect.
			const technical = errorMessage.startsWith('APIConnectionError:')
				? ` (${errorMessage.replace(/^APIConnectionError:\s*/, '').trim()})`
				: '';
			const isLocalProviderName = providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio';
			const causeHint = /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|UNABLE_TO_GET_ISSUER_CERT/i.test(technical)
				? ' Looks like a TLS chain issue — likely a corporate proxy/AV doing TLS interception. Set NODE_EXTRA_CA_CERTS to your corporate root CA, or contact IT.'
				: isLocalProviderName
					? ' This likely means your local model provider like Ollama is powered off, or the endpoint in VibeIDE Settings is wrong.'
					: ' This likely means the network is blocked, the endpoint in VibeIDE Settings is wrong, or the provider is down.';
			// Skip "auto" - it's not a real provider
			if (providerName !== 'auto') {
				errorMessage = `Failed to connect to ${displayInfoOfProviderName(providerName).title}.${causeHint}${technical}`;
			} else {
				errorMessage = `Failed to connect.${causeHint}${technical}`;
			}
		}

		captureLLMEvent(`${loggingName} - Error`, { error: errorMessage });
		onError_({ message: errorMessage, fullError });
	};

	// we should NEVER call onAbort internally, only from the outside
	const onAbort = () => {
		captureLLMEvent(`${loggingName} - Abort`, { messageLengthSoFar: _fullTextSoFar.length });
		try { _aborter?.(); } // aborter sometimes automatically throws an error
		catch (e) { }
		_didAbort = true;
	};
	abortRef_.current = onAbort;


	if (messagesType === 'chatMessages') { captureLLMEvent(`${loggingName} - Sending Message`, {}); }
	else if (messagesType === 'FIMMessage') { captureLLMEvent(`${loggingName} - Sending FIM`, { prefixLen: messages_?.prefix?.length, suffixLen: messages_?.suffix?.length }); }


	try {
		// Skip "auto" - it's not a real provider
		if (providerName === 'auto') {
			onError({ message: `Error: Cannot use "auto" provider - must resolve to a real model first. This usually means auto model selection failed. Please check your model provider settings or select a specific model.`, fullError: null });
			return;
		}
		// Built-in providers resolve from the static map. A DYNAMIC provider (.vibe/providers.json)
		// isn't a key there — route it through the AI-SDK path when its transient transport overlay
		// carries a baseURL (set on the send-site). No baseURL → fall through to "not recognized"
		// (nothing to send to). Built-ins are unaffected: their map entry is always found first.
		const dynamicHasTransport = !!(settingsOfProvider as unknown as Record<string, { baseURL?: string } | undefined>)[providerName]?.baseURL;
		const implementation = sendLLMMessageToProviderImplementation[providerName]
			?? (dynamicHasTransport ? dynamicProviderImplementation : undefined);
		if (!implementation) {
			onError({ message: `Error: Provider "${providerName}" not recognized.`, fullError: null });
			return;
		}
		const { sendFIM, sendChat } = implementation;
		if (messagesType === 'chatMessages') {
			await sendChat({ messages: messages_, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage, chatMode, mcpTools, runtimeOptions });
			return;
		}
		if (messagesType === 'FIMMessage') {
			if (sendFIM) {
				// Infer featureName from loggingName for max_tokens optimization
				// "Autocomplete" -> 'Autocomplete', others default to undefined (safe default)
				const inferredFeatureName: FeatureName | undefined = loggingName === 'Autocomplete' ? 'Autocomplete' : undefined;
				await sendFIM({ messages: messages_, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage, featureName: inferredFeatureName, runtimeOptions });
				return;
			}
			onError({ message: `Error running Autocomplete with ${providerName} - ${modelName}.`, fullError: null });
			return;
		}
		onError({ message: `Error: Message type "${messagesType}" not recognized.`, fullError: null });
		return;
	}

	catch (error) {
		if (error instanceof Error) { onError({ message: error + '', fullError: error }); }
		else { onError({ message: `Unexpected Error in sendLLMMessage: ${error}`, fullError: error }); }
		// ; (_aborter as any)?.()
		// _didAbort = true
	}



};

