/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoiceProfileId, VOICE_SAMPLE_RATE } from './vibeVoiceTypes.js';
import { VoiceCloudMode } from './vibeVoiceConfiguration.js';

/**
 * Cloud dictation through Gemini Live Transcribe — the wire messages, as pure functions.
 *
 * WHY this model and not `gemini-3.8-live`: the Live conversational model answers only with audio, so
 * using it as speech-to-text pays for speech nobody listens to. `gemini-3.5-transcribe-live` is the
 * transcription pipeline: text out, interim and final transcripts, `ru-RU` among its languages
 * (ai.google.dev/gemini-api/docs/live-api/live-transcribe, checked 17.09.2026).
 */

/**
 * Hard limit of one transcription stream, from the vendor's page: «continuous streaming up to 10 minutes»
 * (ai.google.dev/gemini-api/docs/live-api/live-transcribe, checked 18.09.2026).
 */
export const GEMINI_TRANSCRIBE_STREAM_LIMIT_MS = 10 * 60_000;

/**
 * When a session opens its replacement, before the limit rather than after it.
 *
 * `goAway` is documented for the conversational Live model, not for this one, so waiting for it is
 * waiting for a signal that may never come — and then the socket just closes mid-dictation. The margin
 * is a minute: enough for the new connection to finish its setup while the old one still carries audio.
 */
export const GEMINI_TRANSCRIBE_RENEW_MS = GEMINI_TRANSCRIBE_STREAM_LIMIT_MS - 60_000;

/** The Live model that transcribes and does not talk back. */
export const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';

const GEMINI_LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** BCP-47 code Live Transcribe expects for each dictation profile. */
const LANGUAGE_OF_PROFILE: Readonly<Record<VoiceProfileId, string>> = { ru: 'ru-RU', en: 'en-US' };

/** WebSocket URL with the key as the query parameter the API documents. */
export function geminiLiveUrl(apiKey: string): string {
	return `${GEMINI_LIVE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
}

/** What the caller wants from the transcript, beyond the language. */
export interface GeminiTranscribeOptions {
	/** `SMART` tidies the text; `VERBATIM` is the vendor's default and is sent explicitly. */
	readonly mode?: VoiceCloudMode;
	/** Project terms to bias recognition towards. Empty list — the field is not sent at all. */
	readonly vocabulary?: readonly string[];
}

/** First message of a connection: model, text-only responses, transcription in the profile's language. */
export function buildGeminiTranscribeSetup(profileId: VoiceProfileId, options: GeminiTranscribeOptions = {}): object {
	const vocabulary = options.vocabulary ?? [];
	return {
		setup: {
			model: `models/${GEMINI_TRANSCRIBE_MODEL}`,
			generationConfig: { responseModalities: ['TEXT'] },
			inputAudioTranscription: {
				languageCodes: [LANGUAGE_OF_PROFILE[profileId]],
				mode: options.mode === 'verbatim' ? 'VERBATIM' : 'SMART',
				// An empty list is not «no preference» to every API — it is a list. Omit the field instead.
				...(vocabulary.length > 0 ? { customVocabulary: [...vocabulary] } : {}),
			},
		},
	};
}

/** One chunk of 16 kHz mono PCM16, base64-encoded. */
export function buildGeminiAudioMessage(pcmBase64: string): object {
	return { realtimeInput: { audio: { data: pcmBase64, mimeType: `audio/pcm;rate=${VOICE_SAMPLE_RATE}` } } };
}

/** End of the audio stream: the service commits what it heard. */
export function buildGeminiAudioStreamEnd(): object {
	return { realtimeInput: { audioStreamEnd: true } };
}

/** What one server message means for a dictation session. Fields are independent: one message may carry several. */
export interface GeminiLiveEvent {
	readonly setupComplete?: true;
	readonly interim?: string;
	readonly final?: string;
	/** The server will close the connection soon — reconnect before the audio is cut. */
	readonly goAway?: true;
	readonly error?: string;
}

/** A server message, parsed; anything unreadable is reported as an error rather than ignored. */
export function parseGeminiLiveMessage(text: string): GeminiLiveEvent {
	let message: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== 'object') {
			return { error: 'unexpected message' };
		}
		message = parsed as Record<string, unknown>;
	} catch {
		return { error: 'unreadable message' };
	}
	const content = message.serverContent && typeof message.serverContent === 'object' ? message.serverContent as Record<string, unknown> : undefined;
	const textOf = (value: unknown): string | undefined => {
		const t = value && typeof value === 'object' ? (value as { text?: unknown }).text : undefined;
		return typeof t === 'string' && t.length > 0 ? t : undefined;
	};
	const error = message.error && typeof message.error === 'object' ? (message.error as { message?: unknown }).message : undefined;
	const interim = textOf(content?.interimInputTranscription);
	const final = textOf(content?.inputTranscription);
	return {
		...(message.setupComplete !== undefined ? { setupComplete: true as const } : {}),
		...(interim ? { interim } : {}),
		...(final ? { final } : {}),
		...(message.goAway !== undefined ? { goAway: true as const } : {}),
		...(typeof error === 'string' ? { error } : {}),
	};
}
