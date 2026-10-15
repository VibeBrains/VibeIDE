/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input — what the person is told when dictation fails.
 * Pure translation of a raw failure (a DOMException name from `getUserMedia`, an engine message from the worker or the
 * main process, a download error) into a Russian sentence plus the one action that helps.
 * The service shows it as a notification and, when `journal` is set, keeps a line in the chat journal.
 */

import { localize } from '../../../../../nls.js';

export type VoicePlatform = 'mac' | 'windows' | 'other';

/** The raw failure as the service sees it, before any wording. */
export type VoiceFailure =
	| { readonly type: 'mic'; readonly name: string; readonly message?: string }
	| { readonly type: 'engine'; readonly message: string }
	| { readonly type: 'download'; readonly message: string }
	| { readonly type: 'noSpeech' };

export type VoiceErrorKind =
	| 'micDenied' | 'micNotFound' | 'micBusy' | 'micFailed'
	| 'modelsMissing' | 'downloadFailed'
	| 'engineCrashed' | 'engineTimeout' | 'engineFailed'
	| 'noSpeech';

/** The one button under the message; `none` — the message stands alone. */
export type VoiceErrorAction = 'none' | 'openMicSettings' | 'retry' | 'downloadModels' | 'retryDownload';

export interface VoiceErrorInfo {
	readonly kind: VoiceErrorKind;
	readonly message: string;
	/** `info` — an expected outcome, not a fault (nothing was recognized). */
	readonly severity: 'info' | 'warning' | 'error';
	readonly action: VoiceErrorAction;
	/**
	 * Goes to the chat journal as well: a fault the person may want to find again
	 * An expected outcome is not worth a line
	 */
	readonly journal: boolean;
}

/** The engine messages the main process and the worker emit that carry a meaning of their own. */
const ENGINE_MODELS_MISSING = /not installed|did not contain the expected files/i;
const ENGINE_CRASHED = /^(crash|exit)$/i;
const ENGINE_TIMEOUT = /^timeout$/i;
const CYRILLIC = /[а-яё]/i;
const DETAIL_MAX_CHARS = 200;

/** Engine message the stop watchdog of the main process reports when the worker did not confirm the flush. */
export const VOICE_ENGINE_TIMEOUT_MESSAGE = 'timeout';

const MIC_SETTINGS_URIS: Record<VoicePlatform, string | undefined> = {
	mac: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
	windows: 'ms-settings:privacy-microphone',
	other: undefined,
};

/** Where the system asks for microphone access; absent when the platform has no such page to open. */
export function voiceMicSettingsUri(platform: VoicePlatform): string | undefined {
	return MIC_SETTINGS_URIS[platform];
}

function trimDetail(raw: string): string {
	const single = raw.replace(/^Error:\s*/, '').replace(/\s+/g, ' ').trim();
	return single.length > DETAIL_MAX_CHARS ? `${single.slice(0, DETAIL_MAX_CHARS)}…` : single;
}

function micDeniedMessage(platform: VoicePlatform): string {
	switch (platform) {
		case 'mac':
			return localize('vibeVoice.err.micDeniedMac', "Нет доступа к микрофону. Разрешите VibeIDE запись звука: Системные настройки → Конфиденциальность и безопасность → Микрофон. Затем повторите.");
		case 'windows':
			return localize('vibeVoice.err.micDeniedWin', "Нет доступа к микрофону. Разрешите приложениям запись звука: Параметры → Конфиденциальность → Микрофон. Затем повторите.");
		default:
			return localize('vibeVoice.err.micDeniedOther', "Нет доступа к микрофону. Разрешите VibeIDE запись звука в настройках системы и повторите.");
	}
}

function describeMic(name: string, message: string | undefined, platform: VoicePlatform): VoiceErrorInfo {
	switch (name) {
		case 'NotAllowedError':
		case 'SecurityError':
			return {
				kind: 'micDenied',
				message: micDeniedMessage(platform),
				severity: 'warning',
				action: voiceMicSettingsUri(platform) ? 'openMicSettings' : 'none',
				journal: true,
			};
		case 'NotFoundError':
		case 'OverconstrainedError':
			return {
				kind: 'micNotFound',
				message: localize('vibeVoice.err.micNotFound', "Микрофон не найден. Подключите устройство ввода звука и повторите."),
				severity: 'warning',
				action: 'retry',
				journal: true,
			};
		case 'NotReadableError':
		case 'AbortError':
			return {
				kind: 'micBusy',
				message: localize('vibeVoice.err.micBusy', "Микрофон занят другой программой или не отвечает. Закройте её и повторите."),
				severity: 'warning',
				action: 'retry',
				journal: true,
			};
		default:
			return {
				kind: 'micFailed',
				message: localize('vibeVoice.err.micFailed', "Не удалось начать запись с микрофона: {0}", trimDetail(message || name || '?')),
				severity: 'error',
				action: 'retry',
				journal: true,
			};
	}
}

function describeEngine(raw: string): VoiceErrorInfo {
	if (ENGINE_MODELS_MISSING.test(raw)) {
		return {
			kind: 'modelsMissing',
			message: localize('vibeVoice.err.modelsMissing', "Модели голосового ввода не скачаны или повреждены. Скачайте их и повторите."),
			severity: 'warning',
			action: 'downloadModels',
			journal: true,
		};
	}
	if (ENGINE_CRASHED.test(raw.trim())) {
		return {
			kind: 'engineCrashed',
			message: localize('vibeVoice.err.engineCrashed', "Процесс распознавания речи завершился аварийно. Повторите диктовку."),
			severity: 'error',
			action: 'retry',
			journal: true,
		};
	}
	if (ENGINE_TIMEOUT.test(raw.trim())) {
		return {
			kind: 'engineTimeout',
			message: localize('vibeVoice.err.engineTimeout', "Распознавание речи не ответило вовремя. Повторите диктовку."),
			severity: 'error',
			action: 'retry',
			journal: true,
		};
	}
	const detail = trimDetail(raw);
	// The cloud engine words its own failures in Russian already ("нет ключа Gemini…")
	// Wrapping them again only repeats the cause
	return {
		kind: 'engineFailed',
		message: CYRILLIC.test(detail) ? detail : localize('vibeVoice.err.engineFailed', "Сбой распознавания речи: {0}", detail || '?'),
		severity: 'error',
		action: 'retry',
		journal: true,
	};
}

export function describeVoiceError(failure: VoiceFailure, platform: VoicePlatform): VoiceErrorInfo {
	switch (failure.type) {
		case 'mic':
			return describeMic(failure.name, failure.message, platform);
		case 'engine':
			return describeEngine(failure.message);
		case 'download':
			return {
				kind: 'downloadFailed',
				message: localize('vibeVoice.err.downloadFailed', "Не удалось скачать модели голосового ввода: {0}", trimDetail(failure.message) || '?'),
				severity: 'error',
				action: 'retryDownload',
				journal: true,
			};
		case 'noSpeech':
			return {
				kind: 'noSpeech',
				message: localize('vibeVoice.err.noSpeech', "Не расслышал. Говорите ближе к микрофону и повторите."),
				severity: 'info',
				action: 'retry',
				journal: false,
			};
	}
}

/** Journal wording: the label first, then every sentence of the message on its own line. */
export function voiceErrorJournalText(info: VoiceErrorInfo): string {
	const sentences = info.message.split(/(?<=\.)\s+/).filter(line => line.length > 0);
	return [`${localize('vibeVoice.err.journalPrefix', "ГОЛОСОВОЙ ВВОД")}: ${sentences[0] ?? info.message}`, ...sentences.slice(1)].join('\n');
}
