/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { ModelSelection } from '../common/vibeideSettingsTypes.js';
import { councilAdviserPrompt, councilSummaryPrompt, CouncilOpinion, CouncilRequest, CouncilResult } from '../common/modelCouncil.js';

export const IVibeModelCouncilService = createDecorator<IVibeModelCouncilService>('vibeModelCouncilService');

export interface IVibeModelCouncilService {
	readonly _serviceBrand: undefined;
	/** Models configured as advisers, in the order they were listed. */
	advisers(): readonly ModelSelection[];
	/** Asks every adviser in parallel, then has one model fold the answers. */
	ask(request: CouncilRequest, token?: { readonly isCancellationRequested: boolean }): Promise<CouncilResult>;
}

/** `provider/model` entries; empty means the feature stays off. */
export const COUNCIL_ADVISERS_KEY = 'vibeide.council.advisers';
/** Which model folds the opinions; empty falls back to the chat model. */
export const COUNCIL_SUMMARISER_KEY = 'vibeide.council.summariser';
/** Ceiling per adviser, in milliseconds — a council must not hold a turn hostage. */
export const COUNCIL_TIMEOUT_MS = 120000;

function parseSelection(entry: string): ModelSelection | undefined {
	const at = entry.indexOf('/');
	if (at <= 0 || at === entry.length - 1) {
		return undefined;
	}
	return { providerName: entry.slice(0, at).trim() as ModelSelection['providerName'], modelName: entry.slice(at + 1).trim() };
}

/**
 * The council: several models answer the same question independently, one folds the answers.
 *
 * Advisers are asked **in parallel and in isolation** — sequential asking would tempt us to show
 * one answer to the next, and a panel that reads itself stops being independent.
 *
 * Nothing is configured by default: the feature costs N requests instead of one, so it must be
 * an explicit choice rather than something that quietly multiplies a bill.
 */
class VibeModelCouncilService extends Disposable implements IVibeModelCouncilService {
	readonly _serviceBrand: undefined;

	constructor(
		@ILLMMessageService private readonly _llm: ILLMMessageService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IVibeideSettingsService private readonly _settings: IVibeideSettingsService,
	) {
		super();
	}

	advisers(): readonly ModelSelection[] {
		const raw = this._configuration.getValue<string[]>(COUNCIL_ADVISERS_KEY) ?? [];
		return raw.map(parseSelection).filter((s): s is ModelSelection => !!s);
	}

	private _summariser(): ModelSelection | undefined {
		const configured = this._configuration.getValue<string>(COUNCIL_SUMMARISER_KEY);
		const parsed = configured ? parseSelection(configured) : undefined;
		// Falling back to the chat model rather than to the first adviser: an adviser summarising
		// the panel it sits on is judge and party at once.
		return parsed ?? this._settings.state.modelSelectionOfFeature['Chat'] ?? undefined;
	}

	async ask(request: CouncilRequest, token?: { readonly isCancellationRequested: boolean }): Promise<CouncilResult> {
		const advisers = this.advisers();
		if (!advisers.length) {
			return { opinions: [], summary: undefined, summaryError: 'Советники не настроены — заполните «vibeide.council.advisers».' };
		}

		const prompt = councilAdviserPrompt(request);
		const opinions = await Promise.all(advisers.map(selection => this._askOne(selection, prompt, token)));

		if (token?.isCancellationRequested) {
			return { opinions, summary: undefined, summaryError: 'Совет прерван.' };
		}
		if (!opinions.some(o => !o.error && o.text.trim())) {
			return { opinions, summary: undefined, summaryError: 'Ни один советник не ответил.' };
		}

		const summariser = this._summariser();
		if (!summariser) {
			return { opinions, summary: undefined, summaryError: 'Некому свести мнения: не выбрана модель чата и не задан «vibeide.council.summariser».' };
		}
		const folded = await this._askOne(summariser, councilSummaryPrompt(request, opinions), token);
		return folded.error || !folded.text.trim()
			? { opinions, summary: undefined, summaryError: folded.error ?? 'пустой ответ' }
			: { opinions, summary: folded.text };
	}

	/** One adviser. Never rejects: a dead provider is an opinion that did not arrive, not a crash. */
	private _askOne(selection: ModelSelection, prompt: string, token?: { readonly isCancellationRequested: boolean }): Promise<CouncilOpinion> {
		const startedAt = Date.now();
		return new Promise<CouncilOpinion>(resolve => {
			let settled = false;
			const finish = (over: { text?: string; error?: string }) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				resolve({ providerName: selection.providerName, modelName: selection.modelName, text: over.text ?? '', error: over.error, durationMs: Date.now() - startedAt });
			};

			const requestId = this._llm.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: prompt } as never],
				separateSystemMessage: undefined,
				chatMode: 'normal',
				modelSelection: selection,
				modelSelectionOptions: undefined,
				overridesOfModel: this._settings.state.overridesOfModel,
				onText: () => { },
				onFinalMessage: p => finish({ text: p.fullText }),
				onError: e => finish({ error: e.message || String(e) }),
				onAbort: () => finish({ error: 'запрос прерван' }),
				// The council has its own cost story (N requests for one question) and must not eat
				// the session budget of the run that asked for advice.
				excludeFromSessionBudget: true,
				logging: { loggingName: `Council/${selection.providerName}` },
			});
			if (requestId === null) {
				finish({ error: 'провайдер не принял запрос' });
				return;
			}

			const timer = setTimeout(() => {
				this._llm.abort(requestId);
				finish({ error: `не ответил за ${COUNCIL_TIMEOUT_MS / 1000} с` });
			}, COUNCIL_TIMEOUT_MS);

			if (token?.isCancellationRequested) {
				this._llm.abort(requestId);
				finish({ error: 'совет отменён' });
			}
		});
	}
}

registerSingleton(IVibeModelCouncilService, VibeModelCouncilService, InstantiationType.Delayed);
