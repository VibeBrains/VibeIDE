/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	chargeRoundTrip, deserializeToolCost, EMPTY_TOOL_COST_STATE, endTurn, recordToolResult,
	serializeToolCost, ToolContextTally, ToolCostState, totalContextCost, worstOffenders,
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
	/** A tool returned this much text into the context. */
	noteResult(toolName: string, resultChars: number): void;
	/** A request went out carrying everything the turn has accumulated so far. */
	noteRoundTrip(): void;
	/** The turn ended: its context is gone and stops being re-billed. */
	noteTurnEnd(): void;
	/** Worst offenders, heaviest first. */
	top(limit: number): ToolContextTally[];
	/** Produced once versus re-sent, in tokens. */
	totals(): { produced: number; carried: number };
	/** Forget everything measured so far — for starting a clean comparison. */
	reset(): void;
}

const STORAGE_KEY = 'vibeide.toolContextCost';

class VibeToolContextCostService extends Disposable implements IVibeToolContextCostService {

	declare readonly _serviceBrand: undefined;

	private _state: ToolCostState = EMPTY_TOOL_COST_STATE;

	constructor(
		@IStorageService private readonly _storage: IStorageService,
	) {
		super();
		try {
			this._state = deserializeToolCost(JSON.parse(this._storage.get(STORAGE_KEY, StorageScope.PROFILE, '{}')));
		} catch {
			// A corrupted store costs the history, not the session: measuring starts again.
			vibeLog.warn('toolCost', 'сохранённый учёт инструментов нечитаем — начинаю заново');
		}
	}

	noteResult(toolName: string, resultChars: number): void {
		const next = recordToolResult(this._state, toolName, resultChars);
		if (next !== this._state) {
			this._state = next;
			this._persist();
		}
	}

	noteRoundTrip(): void {
		// Not persisted here: a round-trip only moves numbers that the next result write will save
		// anyway, and a turn of forty steps would otherwise be forty writes to storage.
		this._state = chargeRoundTrip(this._state);
	}

	noteTurnEnd(): void {
		this._state = endTurn(this._state);
		this._persist();
	}

	top(limit: number): ToolContextTally[] {
		return worstOffenders(this._state, limit);
	}

	totals(): { produced: number; carried: number } {
		return totalContextCost(this._state);
	}

	reset(): void {
		this._state = EMPTY_TOOL_COST_STATE;
		this._persist();
	}

	private _persist(): void {
		this._storage.store(STORAGE_KEY, JSON.stringify(serializeToolCost(this._state)), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}

registerSingleton(IVibeToolContextCostService, VibeToolContextCostService, InstantiationType.Delayed);
