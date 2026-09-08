/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	chargeRoundTrip, deserializeToolCost, EMPTY_LIVE_WEIGHTS, EMPTY_TOOL_COST_TOTALS, recordToolResult,
	serializeToolCost, ToolContextTally, ToolCostTotals, totalContextCost, TurnLiveWeights, worstOffenders,
} from '../common/toolContextCost.js';
import { vibeLog } from '../common/vibeLog.js';

/**
 * Кто из инструментов дороже всех обходится в перечитывании.
 *
 * The spend report says what a month cost; the tool log says which tool ran. Neither answers the
 * question that changes anything — which tool's output the model is paying for over and over. This
 * service keeps that one number, because it cannot be derived afterwards from either log.
 *
 * Totals are per profile and survive restarts: a tax that only shows up over a week of work is not
 * visible inside one session, which is exactly why it went unmeasured for so long.
 */

export const IVibeToolContextCostService = createDecorator<IVibeToolContextCostService>('vibeToolContextCostService');

export interface IVibeToolContextCostService {
	readonly _serviceBrand: undefined;
	/** A tool returned this much text into this conversation's context. */
	noteResult(threadId: string, toolName: string, resultChars: number): void;
	/** A request went out carrying everything this conversation's turn has accumulated. */
	noteRoundTrip(threadId: string): void;
	/**
	 * This conversation stopped running: its context is gone and stops being re-billed.
	 *
	 * Called from the one place that knows a thread went idle — however it got there, including an
	 * interrupt or an error. Anchoring it to the happy path instead would leave the weights live,
	 * and the NEXT turn would be billed for a window it never sent.
	 */
	noteTurnEnd(threadId: string): void;
	/** Worst offenders, heaviest first. */
	top(limit: number): ToolContextTally[];
	/** Produced once versus re-sent, in tokens. */
	totals(): { produced: number; carried: number };
	/** Forget everything measured so far — for starting a clean comparison. */
	reset(): void;
}

const STORAGE_KEY = 'vibeide.toolContextCost';

/** How many tool results accumulate before the totals are written out. */
const WRITE_EVERY_RESULTS = 10;

class VibeToolContextCostService extends Disposable implements IVibeToolContextCostService {

	declare readonly _serviceBrand: undefined;

	private _totals: ToolCostTotals = EMPTY_TOOL_COST_TOTALS;

	/**
	 * Live weight per conversation. Two chat tabs carry two context windows, and a single shared map
	 * would let one thread's turn end zero the other's — or charge it for tokens it never sent.
	 */
	private readonly _live = new Map<string, TurnLiveWeights>();

	/** Results recorded since the last write, so a forty-step turn is not forty writes to storage. */
	private _unsavedResults = 0;

	constructor(
		@IStorageService private readonly _storage: IStorageService,
	) {
		super();
		try {
			this._totals = deserializeToolCost(JSON.parse(this._storage.get(STORAGE_KEY, StorageScope.PROFILE, '{}')));
		} catch {
			// A corrupted store costs the history, not the session: measuring starts again.
			vibeLog.warn('toolCost', 'сохранённый учёт инструментов нечитаем — начинаю заново');
		}
	}

	noteResult(threadId: string, toolName: string, resultChars: number): void {
		const next = recordToolResult(this._totals, this._live.get(threadId) ?? EMPTY_LIVE_WEIGHTS, toolName, resultChars);
		if (next.totals === this._totals) {
			return;
		}
		this._totals = next.totals;
		this._live.set(threadId, next.live);
		// Written in batches: a long turn is dozens of results, and storage does not need to know
		// about each one to survive a crash with a useful number.
		if (++this._unsavedResults >= WRITE_EVERY_RESULTS) {
			this._persist();
		}
	}

	noteRoundTrip(threadId: string): void {
		const live = this._live.get(threadId);
		if (live) {
			this._totals = chargeRoundTrip(this._totals, live);
		}
	}

	noteTurnEnd(threadId: string): void {
		if (!this._live.delete(threadId)) {
			// Nothing was live — a thread that went idle without calling a tool. Persisting here would
			// write on every idle transition in the window, which is most of them.
			return;
		}
		this._persist();
	}

	top(limit: number): ToolContextTally[] {
		return worstOffenders(this._totals, limit);
	}

	totals(): { produced: number; carried: number } {
		return totalContextCost(this._totals);
	}

	reset(): void {
		this._totals = EMPTY_TOOL_COST_TOTALS;
		this._live.clear();
		this._persist();
	}

	private _persist(): void {
		this._unsavedResults = 0;
		this._storage.store(STORAGE_KEY, JSON.stringify(serializeToolCost(this._totals)), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}

registerSingleton(IVibeToolContextCostService, VibeToolContextCostService, InstantiationType.Delayed);
