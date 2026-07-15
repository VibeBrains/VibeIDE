/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceSendLLMMessageParams, ServiceModelListParams, OllamaModelResponse, OpenaiCompatibleModelResponse } from './sendLLMMessageTypes.js';
import { NormalizeCounterKey } from './xmlToolNormalize.js';
import type { LlmSendTraceEvent } from './llmSendTrace.js';

// Реализация — `electron-browser/sendLLMMessageService.ts`: класс держит `IMainProcessService`
// (канал `vibeide-channel-llmMessage`), запрещённый и в `common/**`, и в `browser/**`.
// Контракт обязан остаться здесь: `ILLMMessageService` берут 14 потребителей, из них ШЕСТЬ живут в
// `common/` (refreshModel, errorDetection, modelWarmup, nextEditPrediction, nlShellParser,
// codeReview) — поэтому файл нельзя перенести даже в `browser/`. `TransportDiagnostics` вдобавок
// импортирует `electron-main/sendLLMMessageChannel.ts`, то есть контракт держит обе стороны канала.

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
	/** Diagnostic: live tool-call normalization layer hit counters from main (since IDE start / last reset). */
	getNormalizeCounters: () => Promise<Readonly<Record<NormalizeCounterKey, number>>>;
	/** Diagnostic: zero the normalization counters (for switch-model A/B checks). */
	resetNormalizeCounters: () => Promise<void>;
	/** Diagnostic: normalization layer hit counters broken down per `${provider}:${model}`. */
	getNormalizeCountersByModel: () => Promise<Readonly<Record<string, Readonly<Record<NormalizeCounterKey, number>>>>>;
	/** Diagnostic: main-process send-path trace ring (providers-sync / cache / dispatcher / first-chunk / errors). */
	getSendTrace: () => Promise<readonly LlmSendTraceEvent[]>;
	/** Diagnostic: empty the send-path trace ring. */
	clearSendTrace: () => Promise<void>;
}

/** Live shared-dispatcher generation snapshot — see `getDispatcherDiagnostics` in systemCAFetch. */
export interface TransportDiagnostics {
	/** monotonic dispatcher generation; bumps on every (re)create */
	readonly id: number;
	/** how long the current pool has been reused, ms */
	readonly ageMs: number;
	readonly initialized: boolean;
}

