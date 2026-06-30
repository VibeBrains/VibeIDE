/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { LLMChatMessage, LLMFIMMessage, LLMRuntimeOptions, ModelListParams, OnError, OnFinalMessage, OnText } from '../../common/sendLLMMessageTypes.js';
import { ChatMode, FeatureName, ModelSelectionOptions, OverridesOfModel, ProviderName, SettingsOfProvider } from '../../common/vibeideSettingsTypes.js';
import { InternalToolInfo } from '../../common/prompt/prompts.js';

export type InternalCommonMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	modelName: string;
	_setAborter: (aborter: () => void) => void;
	runtimeOptions?: LLMRuntimeOptions;
};

export type SendChatParams_Internal = InternalCommonMessageParams & {
	messages: LLMChatMessage[];
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
	mcpTools: InternalToolInfo[] | undefined;
};

export type SendFIMParams_Internal = InternalCommonMessageParams & {
	messages: LLMFIMMessage;
	separateSystemMessage: string | undefined;
	featureName?: FeatureName;
};

export type ListParams_Internal<ModelResponse> = ModelListParams<ModelResponse>;
