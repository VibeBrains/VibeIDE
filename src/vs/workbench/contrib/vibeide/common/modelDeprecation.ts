/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VibeModelDeprecation } from './vibeProvidersFile.js';

/**
 * When a model is being retired — the decision half, without any UI.
 *
 * Vendors announce a shutdown in a changelog nobody re-reads and then answer 404 on the day. The
 * user meets that mid-task, which is the worst possible moment: the work is already started and the
 * choice of model is no longer cheap. This module turns a declared date into a state the picker can
 * show while the choice is still being made.
 *
 * Deliberately NOT a hard block. A retired model that still answers is the user's business, and a
 * date can be wrong — vendors postpone. We say what we know and let the person decide.
 */

/** How urgent it is, coarsely — the picker maps this onto its own visuals. */
export type DeprecationSeverity = 'retired' | 'soon' | 'announced';

export interface DeprecationStatus {
	readonly severity: DeprecationSeverity;
	/** Days until the shutdown; negative once it has passed, undefined when no date was given. */
	readonly daysLeft?: number;
	readonly replacedBy?: string;
	readonly note?: string;
}

/** Inside this many days the retirement stops being a footnote. */
export const DEPRECATION_SOON_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * Judge a declared deprecation against the clock.
 *
 * `now` is a parameter rather than `Date.now()` so the caller's clock is testable — and because a
 * pure function that reads the wall clock is not pure.
 *
 * An unparsable date is treated as «announced without a date», not as an error: the vendor did say
 * the model is going away, and dropping that because the string was malformed would hide the part
 * that matters. A date in the past means retired, regardless of what else was written.
 */
export function deprecationStatus(deprecation: VibeModelDeprecation | undefined, now: number): DeprecationStatus | undefined {
	if (!deprecation) {
		return undefined;
	}
	const { date, replacedBy, note } = deprecation;
	const parsed = date ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
	if (Number.isNaN(parsed)) {
		return { severity: 'announced', replacedBy, note };
	}
	const daysLeft = Math.floor((parsed - now) / MS_PER_DAY);
	const severity: DeprecationSeverity = daysLeft < 0
		? 'retired'
		: daysLeft <= DEPRECATION_SOON_DAYS ? 'soon' : 'announced';
	return { severity, daysLeft, replacedBy, note };
}

/**
 * Should the model still be offered for automatic selection?
 *
 * Auto-pick is the one place where the user is not choosing, so a model the vendor already turned
 * off must not be handed to them silently. Everything short of retired stays available: a date
 * three months out is a reason to warn, not to take the model away.
 */
export function excludedFromAutoPick(status: DeprecationStatus | undefined): boolean {
	return status?.severity === 'retired';
}
