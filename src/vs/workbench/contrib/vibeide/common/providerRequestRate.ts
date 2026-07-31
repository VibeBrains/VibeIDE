/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How many requests we actually sent to a provider in the trailing minute.
 *
 * Vendors publish their limits per minute (MiniMax-M3: 200 RPM / 10M TPM —
 * https://platform.minimax.io/docs/guides/rate-limits), so when a refusal arrives the first
 * question is always "were we anywhere near it?". Without this number the answer is a guess:
 * the 30.07 MiniMax abort was blamed on rate limiting for months when the observed rate was
 * ~7.5 RPM — nowhere near the ceiling (docs/knowledge/chatUx/modelStalls.md, incident #001).
 *
 * Deliberately an observation, not a limiter: nothing here delays or blocks a request. It only
 * makes the rate visible at the moment it matters.
 *
 * Pure and clock-injected — every method takes `now`, so tests never touch the wall clock.
 */

/** Vendors state limits per minute, so that is the window worth reporting. */
export const REQUEST_RATE_WINDOW_MS = 60_000;

/**
 * Hard cap on retained timestamps per provider. A runaway loop must not grow this unboundedly;
 * once the window holds more than any published limit, the exact count stops being interesting.
 */
const MAX_RETAINED_PER_PROVIDER = 1000;

export class ProviderRequestRateWindow {
	private readonly stampsOfProvider = new Map<string, number[]>();

	constructor(private readonly windowMs: number = REQUEST_RATE_WINDOW_MS) { }

	/** Records one outgoing request and returns how many now fall inside the window (this one included). */
	record(providerName: string, now: number): number {
		const stamps = this.stampsOfProvider.get(providerName) ?? [];
		stamps.push(now);
		const kept = this.prune(stamps, now);
		this.stampsOfProvider.set(providerName, kept);
		return kept.length;
	}

	/** Requests inside the window right now, without recording a new one. */
	countIn(providerName: string, now: number): number {
		const stamps = this.stampsOfProvider.get(providerName);
		if (!stamps) { return 0; }
		const kept = this.prune(stamps, now);
		this.stampsOfProvider.set(providerName, kept);
		return kept.length;
	}

	get windowSeconds(): number {
		return Math.round(this.windowMs / 1000);
	}

	/** Drops timestamps that fell out of the window, then enforces the retention cap. */
	private prune(stamps: number[], now: number): number[] {
		const cutoff = now - this.windowMs;
		let firstLive = 0;
		while (firstLive < stamps.length && stamps[firstLive] <= cutoff) { firstLive++; }
		const live = firstLive > 0 ? stamps.slice(firstLive) : stamps;
		return live.length > MAX_RETAINED_PER_PROVIDER ? live.slice(live.length - MAX_RETAINED_PER_PROVIDER) : live;
	}
}
