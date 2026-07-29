/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { vibeLog } from '../common/vibeLog.js';
import {
	byModel,
	byProvider,
	emptyLedger,
	entriesInWindow,
	ModelPrice,
	parseLedger,
	recordSpend,
	SpendEntry,
	SpendLedgerState,
	SpendTotals,
	totalsOf,
} from '../common/spendLedger.js';

/** Where the ledger lives. APPLICATION scope: the bill follows the user, not the folder. */
const SPEND_STORAGE_KEY = 'vibeide.spendLedger';

export const IVibeSpendLedgerService = createDecorator<IVibeSpendLedgerService>('vibeSpendLedgerService');

export interface IVibeSpendLedgerService {
	readonly _serviceBrand: undefined;
	/** Fires after a recorded exchange, so an open report can refresh itself. */
	readonly onDidChange: Event<void>;
	/** Folds one model exchange into the ledger and persists it. */
	record(params: {
		providerId: string;
		modelId: string;
		inputTokens: number;
		outputTokens: number;
		cachedInputTokens?: number;
		price?: ModelPrice;
	}): void;
	/** Entries of the last `days` days (day 1 = today), newest day first. */
	window(days: number): SpendEntry[];
	totals(days: number): SpendTotals;
	perProvider(days: number): Array<{ providerId: string; totals: SpendTotals }>;
	perModel(days: number): Array<{ providerId: string; modelId: string; totals: SpendTotals }>;
	/** Wipes the history. Irreversible by design — this is the user's "forget my spending". */
	clear(): void;
}

/**
 * Keeps the spend ledger and persists it.
 *
 * Persistence is the whole point: before this the provider dashboard read an in-memory
 * fingerprint buffer that nobody wrote, so it always showed `$0.0000`. Money spent yesterday
 * has to be there tomorrow, otherwise the panel answers a question nobody asked.
 */
class VibeSpendLedgerService extends Disposable implements IVibeSpendLedgerService {
	declare readonly _serviceBrand: undefined;

	private _state: SpendLedgerState;
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._state = parseLedger(this._storageService.get(SPEND_STORAGE_KEY, StorageScope.APPLICATION));
	}

	record(params: {
		providerId: string;
		modelId: string;
		inputTokens: number;
		outputTokens: number;
		cachedInputTokens?: number;
		price?: ModelPrice;
	}): void {
		// An exchange with no tokens carries no cost and no signal — recording it would only
		// inflate the request count with aborts and early timeouts.
		if (params.inputTokens <= 0 && params.outputTokens <= 0) {
			return;
		}
		this._state = recordSpend(this._state, { ...params, timestampMs: Date.now() });
		this._persist();
		this._onDidChange.fire();
	}

	window(days: number): SpendEntry[] {
		return entriesInWindow(this._state, Date.now(), days);
	}

	totals(days: number): SpendTotals {
		return totalsOf(this.window(days));
	}

	perProvider(days: number): Array<{ providerId: string; totals: SpendTotals }> {
		return byProvider(this.window(days));
	}

	perModel(days: number): Array<{ providerId: string; modelId: string; totals: SpendTotals }> {
		return byModel(this.window(days));
	}

	clear(): void {
		this._state = emptyLedger();
		this._persist();
		this._onDidChange.fire();
	}

	private _persist(): void {
		try {
			this._storageService.store(SPEND_STORAGE_KEY, JSON.stringify(this._state), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch (err) {
			// Losing the ledger must never break a chat turn — the numbers are informational.
			vibeLog.warn('spendLedger', `failed to persist: ${err}`);
		}
	}
}

registerSingleton(IVibeSpendLedgerService, VibeSpendLedgerService, InstantiationType.Delayed);
