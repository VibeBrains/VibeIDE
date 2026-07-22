/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { toAction } from '../../../../base/common/actions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { ProviderId } from '../common/vibeideSettingsTypes.js';
import { parseQuirkAutoFeedState, recordAutoDowngrade, shouldSuggestDurableXml, markSuggested, buildCatalogRuleSnippet, QUIRK_AUTOSUGGEST_DEFAULT_SESSIONS } from '../common/modelQuirksAutoFeed.js';
import { vibeLog } from '../common/vibeLog.js';

/**
 * Auto-feed of the model-quirks catalog from runtime evidence (roadmap O.13).
 *
 * Listens to auto-downgrade events (chatThreadService switches a model with broken
 * native tool-calls to XML-fallback with a TTL + re-probe). A downgrade repeating
 * across DISTINCT sessions means the self-healing dance burns failing turns every
 * session — that is the signature that justifies a durable fix, so we offer one:
 *  • «Закрепить XML-режим» — durable `setOverridesOfModel(..., { specialToolFormat: null })`
 *    (no `_autoDetected` ⇒ no TTL, no re-probe fighting it);
 *  • «Скопировать правило» — ready-to-PR rule snippet for `resources/model-quirks.json`
 *    (the data-driven path: one-file catalog PR instead of an IDE release).
 * Pure decision logic lives in `common/modelQuirksAutoFeed.ts`.
 */
export interface IVibeQuirkAutoFeedService {
	readonly _serviceBrand: undefined;
	/** Record one auto-downgrade event; may show a (once-per-model, ever) durable-quirk suggestion. */
	recordAutoDowngrade(providerName: ProviderId, modelName: string): void;
}

export const IVibeQuirkAutoFeedService = createDecorator<IVibeQuirkAutoFeedService>('vibeQuirkAutoFeedService');

const STORAGE_KEY = 'vibeide.quirkAutoFeed.stats';
const CONFIG_AUTOSUGGEST = 'vibeide.modelQuirks.autoSuggest';
const CONFIG_AUTOSUGGEST_SESSIONS = 'vibeide.modelQuirks.autoSuggestSessions';

class VibeQuirkAutoFeedService extends Disposable implements IVibeQuirkAutoFeedService {
	readonly _serviceBrand: undefined;

	/** Distinct per IDE window/session — powers the "distinct sessions" dedup in the pure state. */
	private readonly _sessionId = generateUuid();

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
	) {
		super();
	}

	recordAutoDowngrade(providerName: ProviderId, modelName: string): void {
		try {
			const modelKey = `${providerName}:${modelName}`;
			let state = parseQuirkAutoFeedState(this._storageService.get(STORAGE_KEY, StorageScope.APPLICATION));
			state = recordAutoDowngrade(state, modelKey, this._sessionId, Date.now());

			const autoSuggest = this._configurationService.getValue<unknown>(CONFIG_AUTOSUGGEST) !== false;
			const rawSessions = this._configurationService.getValue<unknown>(CONFIG_AUTOSUGGEST_SESSIONS);
			const minSessions = (typeof rawSessions === 'number' && Number.isFinite(rawSessions) && rawSessions >= 1)
				? Math.floor(rawSessions)
				: QUIRK_AUTOSUGGEST_DEFAULT_SESSIONS;

			if (autoSuggest && shouldSuggestDurableXml(state[modelKey], minSessions)) {
				state = markSuggested(state, modelKey);
				this._suggestDurableXml(providerName, modelName, state[modelKey].sessionCount, buildCatalogRuleSnippet(providerName, modelName, state[modelKey]));
			}
			this._storageService.store(STORAGE_KEY, JSON.stringify(state), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch (e) {
			// Evidence bookkeeping must never break the agent loop that calls it.
			vibeLog.warn('vibeQuirkAutoFeed', 'recordAutoDowngrade failed', e);
		}
	}

	private _suggestDurableXml(providerName: ProviderId, modelName: string, sessionCount: number, ruleSnippet: string): void {
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeide.quirkAutoFeed.suggest',
				"Модель {0} ({1}) уже в {2} сессиях уезжала в XML-режим тулов из-за сломанных native tool-call. Можно закрепить XML-режим насовсем — без повторных сбоев в начале каждой сессии.",
				modelName, providerName, String(sessionCount)
			),
			actions: {
				primary: [
					toAction({
						id: 'vibeide.quirkAutoFeed.apply',
						label: localize('vibeide.quirkAutoFeed.applyLabel', "Закрепить XML-режим"),
						run: async () => {
							// null (not undefined): matches the auto-downgrade write — undefined keys are
							// dropped by JSON/IPC serialization and the override would never land in main.
							// No `_autoDetected` ⇒ durable: no TTL expiry, no re-probe reverting it.
							await this._settingsService.setOverridesOfModel(providerName, modelName, { specialToolFormat: null });
							this._notificationService.info(localize(
								'vibeide.quirkAutoFeed.applied',
								"XML-режим закреплён для {0}. Откат: Settings → Models → Overrides → этот провайдер/модель.",
								modelName
							));
						},
					}),
					toAction({
						id: 'vibeide.quirkAutoFeed.copyRule',
						label: localize('vibeide.quirkAutoFeed.copyLabel', "Скопировать правило для каталога"),
						run: async () => {
							await this._clipboardService.writeText(ruleSnippet);
							this._notificationService.info(localize(
								'vibeide.quirkAutoFeed.copied',
								"Правило скопировано. Это готовая запись для PR в resources/model-quirks.json — квирк станет дефолтом для всех пользователей."
							));
						},
					}),
				],
			},
		});
	}
}

registerSingleton(IVibeQuirkAutoFeedService, VibeQuirkAutoFeedService, InstantiationType.Delayed);
