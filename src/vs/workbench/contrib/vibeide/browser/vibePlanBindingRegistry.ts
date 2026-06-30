/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export const IVibePlanBindingRegistry = createDecorator<IVibePlanBindingRegistry>('vibePlanBindingRegistry');

export interface IVibePlanBindingRegistry {
	readonly _serviceBrand: undefined;

	/**
	 * Registers active executor threadId for persisted planId under workspaceFolder.
	 * @returns conflict when another distinct thread was already registered for the same planId.
	 */
	register(workspaceFolder: URI, planId: string, threadId: string): { conflict: boolean; otherThreadIds: string[] };

	unregister(workspaceFolder: URI, planId: string, threadId: string): void;

	getThreadIds(workspaceFolder: URI, planId: string): string[];

	/** Removes threadId from every plan binding (e.g. thread deleted). */
	clearThread(threadId: string): void;
}

class VibePlanBindingRegistry extends Disposable implements IVibePlanBindingRegistry {
	declare readonly _serviceBrand: undefined;

	/** workspaceFolder identity → planId → bound thread ids */
	private readonly _map = new Map<string, Map<string, Set<string>>>();

	private _workspaceKey(folder: URI): string {
		return folder.toString(true);
	}

	register(workspaceFolder: URI, planId: string, threadId: string): { conflict: boolean; otherThreadIds: string[] } {
		const wk = this._workspaceKey(workspaceFolder);
		let byPlan = this._map.get(wk);
		if (!byPlan) {
			byPlan = new Map();
			this._map.set(wk, byPlan);
		}
		let set = byPlan.get(planId);
		if (!set) {
			set = new Set();
			byPlan.set(planId, set);
		}
		const otherThreadIds = [...set].filter(t => t !== threadId);
		const alreadyBound = set.has(threadId);
		set.add(threadId);
		const conflict = !alreadyBound && otherThreadIds.length > 0;
		return { conflict, otherThreadIds };
	}

	unregister(workspaceFolder: URI, planId: string, threadId: string): void {
		const wk = this._workspaceKey(workspaceFolder);
		const byPlan = this._map.get(wk);
		const set = byPlan?.get(planId);
		if (!set) {
			return;
		}
		set.delete(threadId);
		if (set.size === 0) {
			byPlan!.delete(planId);
		}
		if (byPlan!.size === 0) {
			this._map.delete(wk);
		}
	}

	getThreadIds(workspaceFolder: URI, planId: string): string[] {
		const set = this._map.get(this._workspaceKey(workspaceFolder))?.get(planId);
		return set ? [...set] : [];
	}

	clearThread(threadId: string): void {
		const workspaceKeys = [...this._map.keys()];
		for (const wk of workspaceKeys) {
			const byPlan = this._map.get(wk);
			if (!byPlan) {
				continue;
			}
			for (const [planId, set] of [...byPlan.entries()]) {
				if (set.delete(threadId) && set.size === 0) {
					byPlan.delete(planId);
				}
			}
			if (byPlan.size === 0) {
				this._map.delete(wk);
			}
		}
	}
}

registerSingleton(IVibePlanBindingRegistry, VibePlanBindingRegistry, InstantiationType.Eager);
