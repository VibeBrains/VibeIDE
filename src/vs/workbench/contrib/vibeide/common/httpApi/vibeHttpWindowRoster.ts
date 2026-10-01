/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VibeHttpApiRegistration } from './vibeHttpApiTypes.js';

/**
 * Which window serves the HTTP API
 *
 * Exactly one does — the instance registered longest
 * When every window started the listener itself, each start began with a stop:
 * Another window killed the waiting requests of the first one, and every task ran in all windows
 * Seniority makes the choice stable: opening another window changes nothing
 * When the owner reloads or closes, the next in line takes over without a vote
 */
export class VibeHttpWindowRoster {

	/** By instance id; insertion order is seniority */
	private readonly _entries = new Map<string, VibeHttpApiRegistration>();

	/**
	 * Add or refresh an instance
	 * A known instance keeps its place (new port or token only)
	 * A new instance of a window already listed means that window reloaded: the old one leaves, the new one queues last
	 */
	register(registration: VibeHttpApiRegistration): void {
		this.retireWindow(registration.windowId, registration.instanceId);
		this._entries.set(registration.instanceId, registration);
	}

	/** Remove an instance; false when it was not listed */
	unregister(instanceId: string): boolean {
		return this._entries.delete(instanceId);
	}

	/** Remove the instances of a window that reloaded or closed, except `keep`; returns the removed instance ids */
	retireWindow(windowId: number, keep?: string): readonly string[] {
		const retired: string[] = [];
		for (const [instanceId, entry] of this._entries) {
			if (entry.windowId === windowId && instanceId !== keep) {
				this._entries.delete(instanceId);
				retired.push(instanceId);
			}
		}
		return retired;
	}

	get owner(): VibeHttpApiRegistration | undefined {
		for (const entry of this._entries.values()) {
			return entry;
		}
		return undefined;
	}
}
