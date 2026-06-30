/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize } from '../../../../nls.js';

/**
 * AI «thinking» indicator — pure label formatter
 * (roadmap §"Индикация ИИ думает (не вглухую отвал)" + K.4 «runtime таймаут
 * на gap стрима»).
 *
 * Companion to `streamingGapWatchdog.ts` (FSM with side-effect descriptors).
 * The watchdog returns `show-typing | show-waiting | show-retrying(attempt)`
 * — this module turns those into the RU-localised labels that the chat UI
 * and the status-bar entry render. Pure — `vscode`-free — caller passes the
 * side-effect kind plus the time-since-last-chunk so the helper can append
 * «последняя активность N сек назад» without coupling to `Date.now()`.
 */

export type ThinkingPhase =
	| 'idle'
	| 'thinking'
	| 'waiting'
	| 'retrying-1'
	| 'retrying-2'
	| 'failed'
	| 'completed';

export interface ThinkingIndicatorInput {
	readonly phase: ThinkingPhase;
	/**
	 * Milliseconds since the most recent chunk (any tool-call or content).
	 * Pass 0 / undefined when not applicable (idle / completed).
	 */
	readonly lastChunkAgoMs?: number;
	/**
	 * For 'failed' phase: the underlying reason from the watchdog so the
	 * caller can compose a precise hint.
	 */
	readonly failedReason?: 'gap-timeout' | 'cancelled' | 'provider-error';
}

export interface ThinkingIndicatorState {
	readonly visible: boolean;
	readonly text: string;
	readonly hint?: string;
	readonly severity: 'info' | 'warn' | 'error' | 'success';
}

const SECOND = 1_000;
const MINUTE = 60_000;

/**
 * Compose the indicator label + optional «last activity» hint. Pure.
 *
 *   - idle / completed                → hidden
 *   - thinking                        → spinner glyph + «Думает…»
 *   - waiting (gap > 30s default)     → warn + «Ожидание ответа…» + last-activity hint
 *   - retrying-1 / retrying-2         → warn + «Переподключение… (попытка N/2)»
 *   - failed                          → error + reason-specific text
 */
export function buildThinkingIndicator(input: ThinkingIndicatorInput): ThinkingIndicatorState {
	switch (input.phase) {
		case 'idle':
			return { visible: false, text: '', severity: 'info' };
		case 'thinking':
			return {
				visible: true,
				text: `$(loading~spin) ${localize('vibeide.aiThinking.thinking', "Думает…")}`,
				severity: 'info',
				...(maybeHint(input.lastChunkAgoMs)),
			};
		case 'waiting':
			return {
				visible: true,
				text: `$(loading~spin) ${localize('vibeide.aiThinking.waiting', "Ожидание ответа…")}`,
				severity: 'warn',
				...(maybeHint(input.lastChunkAgoMs)),
			};
		case 'retrying-1':
			return {
				visible: true,
				text: `$(sync~spin) ${localize('vibeide.aiThinking.retrying1', "Переподключение… (попытка 1/2)")}`,
				severity: 'warn',
			};
		case 'retrying-2':
			return {
				visible: true,
				text: `$(sync~spin) ${localize('vibeide.aiThinking.retrying2', "Переподключение… (попытка 2/2)")}`,
				severity: 'warn',
			};
		case 'failed': {
			const reason = input.failedReason ?? 'gap-timeout';
			return {
				visible: true,
				text: `$(error) ${localize('vibeide.aiThinking.failed', "Соединение прервано")}`,
				hint: failedHint(reason),
				severity: 'error',
			};
		}
		case 'completed':
			return { visible: false, text: '', severity: 'success' };
	}
}

function maybeHint(ms: number | undefined): { hint: string } | object {
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
		return {};
	}
	return { hint: `Последняя активность ${formatRelativeRu(ms)}` };
}

/**
 * RU relative-time formatter. Pure — uses fixed slavic plural rules so the
 * label reads naturally without `Intl.RelativeTimeFormat` overhead.
 */
export function formatRelativeRu(ms: number): string {
	if (ms < SECOND) { return 'только что'; }
	if (ms < MINUTE) {
		const sec = Math.floor(ms / SECOND);
		return `${sec} ${pluralSec(sec)} назад`;
	}
	const min = Math.floor(ms / MINUTE);
	if (min < 60) { return `${min} ${pluralMin(min)} назад`; }
	const hours = Math.floor(min / 60);
	return `${hours} ${pluralHour(hours)} назад`;
}

function failedHint(reason: 'gap-timeout' | 'cancelled' | 'provider-error'): string {
	switch (reason) {
		case 'gap-timeout':
			return 'Стрим прервался. Проверьте сеть и нажмите «Повторить запрос».';
		case 'cancelled':
			return 'Запрос отменён.';
		case 'provider-error':
			return 'Провайдер вернул ошибку. Проверьте провайдера / квоту.';
	}
}

function pluralSec(n: number): string {
	const last = n % 10;
	const lastTwo = n % 100;
	if (lastTwo >= 11 && lastTwo <= 14) { return 'секунд'; }
	if (last === 1) { return 'секунду'; }
	if (last >= 2 && last <= 4) { return 'секунды'; }
	return 'секунд';
}

function pluralMin(n: number): string {
	const last = n % 10;
	const lastTwo = n % 100;
	if (lastTwo >= 11 && lastTwo <= 14) { return 'минут'; }
	if (last === 1) { return 'минуту'; }
	if (last >= 2 && last <= 4) { return 'минуты'; }
	return 'минут';
}

function pluralHour(n: number): string {
	const last = n % 10;
	const lastTwo = n % 100;
	if (lastTwo >= 11 && lastTwo <= 14) { return 'часов'; }
	if (last === 1) { return 'час'; }
	if (last >= 2 && last <= 4) { return 'часа'; }
	return 'часов';
}
