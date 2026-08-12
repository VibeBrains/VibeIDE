/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * When the daily digest is due, and whether one was missed.
 *
 * Pure on purpose: the whole point of a schedule is the awkward cases — the IDE was closed at the
 * appointed minute, two windows are open, the clock crossed midnight — and none of them can be
 * exercised through a timer without waiting real hours for the answer.
 *
 * The decision this module encodes: a digest that could not be delivered is delivered LATE, not
 * dropped. An agent that ran overnight is exactly the case the digest exists for, and the laptop
 * being shut at 09:00 is not a reason to say nothing about it.
 */

/** Minutes in a day — the wrap-around point when computing the next occurrence. */
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;

/**
 * Parse `HH:MM` (24-hour) into minutes since local midnight.
 *
 * Returns `undefined` for anything malformed rather than falling back to a default: a typo in the
 * setting must surface as "the digest never fires", which the caller reports, instead of silently
 * delivering at an hour the user never chose.
 */
export function parseDigestTime(value: string | undefined): number | undefined {
	if (typeof value !== 'string') { return undefined; }
	const m = /^(?<hours>\d{1,2}):(?<minutes>\d{2})$/.exec(value.trim());
	if (!m?.groups) { return undefined; }
	const hours = Number(m.groups.hours);
	const minutes = Number(m.groups.minutes);
	if (hours > 23 || minutes > 59) { return undefined; }
	return hours * 60 + minutes;
}

/** Local-clock minutes since midnight for a timestamp. */
function minutesOfDay(atMs: number): number {
	const d = new Date(atMs);
	return d.getHours() * 60 + d.getMinutes();
}

/** Local midnight preceding a timestamp. */
function startOfDay(atMs: number): number {
	const d = new Date(atMs);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * The most recent moment the digest was due at or before `nowMs`.
 *
 * Computed from the local calendar day rather than by subtracting 24h from the next occurrence:
 * DST shifts make the day 23 or 25 hours long twice a year, and arithmetic on a fixed day length
 * would move the digest by an hour on those days.
 */
export function lastDueMs(nowMs: number, timeMinutes: number): number {
	const todayDue = startOfDay(nowMs) + timeMinutes * MS_PER_MINUTE;
	if (todayDue <= nowMs) { return todayDue; }
	// Before today's slot → the previous one was yesterday. Re-derive from yesterday's midnight
	// so the hour stays what the user asked for across a DST boundary.
	return startOfDay(nowMs - MINUTES_PER_DAY * MS_PER_MINUTE) + timeMinutes * MS_PER_MINUTE;
}

/**
 * Milliseconds until the next firing, at least 1 so a caller looping on this can never spin.
 */
export function msUntilNextDue(nowMs: number, timeMinutes: number): number {
	const nowMinutes = minutesOfDay(nowMs);
	const deltaMinutes = timeMinutes > nowMinutes
		? timeMinutes - nowMinutes
		: timeMinutes + MINUTES_PER_DAY - nowMinutes;
	// Align to the top of the target minute instead of trusting minute arithmetic alone —
	// otherwise a timer armed at 08:59:59.900 fires 0.1s early and computes the wrong day.
	const seconds = new Date(nowMs).getSeconds();
	const millis = new Date(nowMs).getMilliseconds();
	return Math.max(1, deltaMinutes * MS_PER_MINUTE - seconds * 1000 - millis);
}

/**
 * Should a digest be sent right now for a missed slot?
 *
 * `lastSentMs` is the delivery mark shared by every window (application-scoped storage), which is
 * what keeps two open windows from reporting the same day twice — the second window sees the mark
 * the first one wrote and stays quiet.
 *
 * `undefined` last-sent means "never sent". That deliberately does NOT trigger a catch-up on first
 * ever run: the user has just enabled the feature, and greeting them with yesterday's report is
 * noise, not service. It only arms the mark so the next real slot delivers.
 */
export function isCatchUpDue(nowMs: number, timeMinutes: number, lastSentMs: number | undefined): boolean {
	if (lastSentMs === undefined) { return false; }
	return lastSentMs < lastDueMs(nowMs, timeMinutes);
}

/**
 * Window the digest should cover: from the previous delivery (or the previous slot, whichever is
 * later) up to now.
 *
 * Anchoring at the last delivery rather than a fixed 24 hours is what makes a late digest correct:
 * a report delivered two days late covers two days, and nothing that happened in between quietly
 * falls outside the window.
 */
export function digestPeriod(nowMs: number, timeMinutes: number, lastSentMs: number | undefined): { fromMs: number; toMs: number } {
	const previousSlot = lastDueMs(nowMs - MINUTES_PER_DAY * MS_PER_MINUTE, timeMinutes);
	return { fromMs: lastSentMs ?? previousSlot, toMs: nowMs };
}
