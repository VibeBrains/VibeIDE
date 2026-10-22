/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../../base/common/hash.js';
import { ModelSelection, ProviderId, SettingsOfProvider, builtinProviderIdOf, customSettingNamesOfProvider } from './vibeideSettingsTypes.js';

/**
 * Why a model is closed to this person
 * `region`: the provider serves the model only from another region
 * `quota`: the allowance of the account is spent
 * `access`: the key or the plan does not reach the model (401, 403, «model not on your plan»)
 */
export type UnavailableReason = 'region' | 'quota' | 'access';

/**
 * What an error proves
 * `model`: only the model that answered with it
 * `provider`: every model of its provider, because the cause is the account and not the model
 */
export type UnavailableScope = 'model' | 'provider';

export interface ModelUnavailability {
	readonly scope: UnavailableScope;
	readonly reason: UnavailableReason;
}

/**
 * How long «Авто» holds a model back after an error closed it
 * The cause is fixed outside the IDE (a setting at the provider, a top-up, a window that resets),
 * and nothing here sees that, so the hold expires and the next pick finds out by trying
 */
export const UNAVAILABLE_MARK_TTL_MS = 30 * 60 * 1000;

interface UnavailableMark extends ModelUnavailability {
	readonly markedAt: number;
	/** The provider setup the error was seen under: a new key or endpoint lifts the hold at once */
	readonly setupKey: string;
}

const providerMarkKey = (model: ModelSelection): string => `provider:${model.providerName}`;
const modelMarkKey = (model: ModelSelection): string => `model:${model.providerName}/${model.modelName}`;

/**
 * What of a provider's setup an error depends on: the key and the endpoint, not the model list or the key check state
 * Hashed, so the registry keeps no second copy of the key
 */
export function providerSetupKey(settingsOfProvider: SettingsOfProvider, providerName: ProviderId): string {
	const settings = settingsOfProvider[providerName] as unknown as Record<string, unknown> | undefined;
	// Встроенный провайдер: поля его карточки. Файловый: ключ и адрес — адрес меняют значения параметров (регион, проект, ресурс)
	const builtinId = builtinProviderIdOf(providerName);
	const fieldNames = builtinId ? customSettingNamesOfProvider(builtinId) : ['apiKey', 'endpoint'];
	return String(hash(fieldNames.map(name => settings?.[name] ?? '')));
}

/**
 * Models «Авто» holds back because an error showed them closed to this person
 *
 * In memory and for the session: a mark is lifted by an answer from the model, by a changed key or endpoint
 * of its provider, or by the time running out
 * Pure and without services, so it is tested with a clock passed in
 */
export class ModelAvailabilityRegistry {
	private readonly _marks = new Map<string, UnavailableMark>();

	mark(model: ModelSelection, unavailability: ModelUnavailability, setupKey: string, now: number): void {
		const key = unavailability.scope === 'provider' ? providerMarkKey(model) : modelMarkKey(model);
		this._marks.set(key, { ...unavailability, markedAt: now, setupKey });
	}

	/**
	 * Why the model is held back right now, or `undefined` when «Авто» may pick it
	 * The setup key is asked for only when there is a mark to compare it with: most picks meet none
	 */
	unavailabilityOf(model: ModelSelection, setupKeyOf: () => string, now: number): ModelUnavailability | undefined {
		for (const key of [modelMarkKey(model), providerMarkKey(model)]) {
			const mark = this._marks.get(key);
			if (!mark) {
				continue;
			}
			if (now - mark.markedAt >= UNAVAILABLE_MARK_TTL_MS || mark.setupKey !== setupKeyOf()) {
				this._marks.delete(key);
				continue;
			}
			return { scope: mark.scope, reason: mark.reason };
		}
		return undefined;
	}

	/** The model answered: its own mark and its provider's are stale. Returns whether anything was lifted */
	clear(model: ModelSelection): boolean {
		const lifted = this._marks.delete(modelMarkKey(model));
		return this._marks.delete(providerMarkKey(model)) || lifted;
	}
}
