/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VibeProviderModelCost } from './vibeProvidersFile.js';

/**
 * Цена модели, у которой есть срок годности.
 *
 * WHY: a promotional rate is a price with an expiry date, and vendors publish both — «free through
 * September 25, then $0.06 / $0.18», «the 90% launch promotion ends September 10». We used to store
 * only the first half, so every spend report kept using the promotional number after it expired and
 * quietly under-reported the bill. The user found out from the vendor's invoice, which is the one
 * place we cannot correct.
 *
 * Two things follow from a declared expiry, and only two: the price in effect right now (so the
 * report is right on both sides of the date), and a warning while switching is still cheap (so a
 * ten-fold increase is not met mid-task).
 *
 * Deliberately NOT a block: a model getting more expensive is the user's business, and vendors
 * postpone. We say what we know and let the person decide — the same stance as `modelDeprecation`.
 */

/**
 * Inside this many days an upcoming price change stops being a footnote.
 *
 * A default rather than a constant: `vibeide.providers.priceChangeWarningDays` decides, because how
 * much notice is useful depends on how quickly the person can actually switch models.
 */
export const DEFAULT_PRICE_CHANGE_SOON_DAYS = 14;

const MS_PER_DAY = 86_400_000;

export type PriceChangeSeverity =
	/** The declared date has passed — `costAfter` is what is being billed now. */
	| 'in-effect'
	/** Close enough that the user should see it while choosing the model. */
	| 'soon'
	/** Announced, but far enough away to stay a footnote. */
	| 'announced';

export interface PriceChangeStatus {
	readonly severity: PriceChangeSeverity;
	/** Days until the change; negative once it has passed. */
	readonly daysLeft: number;
	/** How much more expensive input becomes, e.g. `10` for a ten-fold rise. Undefined when unknown. */
	readonly inputMultiplier?: number;
	/** Same for output. Vendors do not always move both by the same factor. */
	readonly outputMultiplier?: number;
	/** Why / where announced — kept so the claim can be checked rather than believed. */
	readonly note?: string;
}

/**
 * Parse a declared moment into a timestamp.
 *
 * Accepts a bare date (`2026-09-25`) and a full ISO instant (`2026-09-09T16:00:00Z`). The instant
 * form matters more than it looks: the vendor deadlines that prompted this field are stated in local
 * time — «24:00 UTC+8 on September 9» — and rounding that to a date would be wrong by most of a day
 * in the direction that costs money. A bare date is read as midnight UTC, which is what a vendor
 * publishing a date without a time means closely enough.
 *
 * Returns `undefined` for anything unparsable rather than throwing: the file is written by hand.
 */
export function parseDeclaredMoment(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	// A bare `YYYY-MM-DD` parses as UTC midnight in every engine; anything longer is left to the
	// engine's ISO parsing, which is where the timezone offset is understood.
	const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? Date.parse(`${trimmed}T00:00:00Z`) : Date.parse(trimmed);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/** Ratio of two rates, when both are known and the old one is not zero. */
function multiplier(before: number | undefined, after: number | undefined): number | undefined {
	if (typeof before !== 'number' || typeof after !== 'number' || before <= 0) {
		return undefined;
	}
	return after / before;
}

/**
 * Which price is actually in effect, given the clock.
 *
 * `now` is a parameter rather than `Date.now()` so callers are testable — and because a function
 * that reads the wall clock is not pure.
 *
 * A schedule without `costAfter` cannot change anything: an expiry date alone says the promotion
 * ends but not what replaces it, and inventing a number would be worse than keeping the old one.
 */
export function effectiveCost<T extends VibeProviderModelCost>(
	cost: T | undefined,
	validUntil: string | undefined,
	costAfter: T | undefined,
	now: number,
): T | undefined {
	if (!costAfter) {
		return cost;
	}
	const moment = parseDeclaredMoment(validUntil);
	if (moment === undefined || now < moment) {
		return cost;
	}
	return costAfter;
}

/**
 * Judge a declared price change against the clock.
 *
 * Undefined when there is nothing to say: no date, no replacement price, or an unparsable date. An
 * unparsable date is dropped here rather than downgraded to «announced without a date» — unlike a
 * retirement, a price change with no date carries no actionable meaning, because the whole point is
 * knowing when to switch.
 */
export function priceChangeStatus(
	cost: VibeProviderModelCost | undefined,
	validUntil: string | undefined,
	costAfter: VibeProviderModelCost | undefined,
	now: number,
	note?: string,
	soonDays: number = DEFAULT_PRICE_CHANGE_SOON_DAYS,
): PriceChangeStatus | undefined {
	if (!costAfter) {
		return undefined;
	}
	const moment = parseDeclaredMoment(validUntil);
	if (moment === undefined) {
		return undefined;
	}
	const daysLeft = Math.floor((moment - now) / MS_PER_DAY);
	const severity: PriceChangeSeverity = now >= moment
		? 'in-effect'
		: daysLeft <= soonDays ? 'soon' : 'announced';
	return {
		severity,
		daysLeft,
		inputMultiplier: multiplier(cost?.input, costAfter.input),
		outputMultiplier: multiplier(cost?.output, costAfter.output),
		note,
	};
}

/**
 * When the next scheduled change takes effect, across a set of models.
 *
 * The caller re-resolves prices at that moment: a rate that flips at midnight must not stay stale
 * until the window happens to be restarted. Moments already past are ignored — they are already
 * applied by `effectiveCost`.
 */
export function nextPriceChangeMoment(
	schedules: readonly { readonly validUntil?: string; readonly costAfter?: VibeProviderModelCost }[],
	now: number,
): number | undefined {
	let soonest: number | undefined;
	for (const schedule of schedules) {
		if (!schedule.costAfter) {
			continue;
		}
		const moment = parseDeclaredMoment(schedule.validUntil);
		if (moment === undefined || moment <= now) {
			continue;
		}
		if (soonest === undefined || moment < soonest) {
			soonest = moment;
		}
	}
	return soonest;
}
