/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input (local speech-to-text) — shared contracts.
 *
 * Pure data shapes and channel/worker protocol types. No node/browser/electron imports:
 * the renderer (electron-browser), the main process and the STT utility process all
 * speak these types over IPC / structured clone.
 *
 * Pipeline overview (see docs/knowledge/voice/):
 *   renderer mic (16 kHz PCM16) → main channel → utility process (sherpa-onnx):
 *   streaming model emits partials; its endpointing closes a phrase; the phrase audio
 *   is re-decoded by the offline model (when the profile has one) for the final text.
 */

export const VIBE_VOICE_CHANNEL = 'vibeide-channel-voice';

/** Language profile of the STT engine. Selected from `accessibility.voice.speechLanguage`. */
export type VoiceProfileId = 'ru' | 'en';

export const VOICE_PROFILE_IDS: readonly VoiceProfileId[] = ['ru', 'en'];

/** Audio contract between capture (renderer) and engine (worker). */
export const VOICE_SAMPLE_RATE = 16000;

/** Streaming (online) model descriptor with absolute file paths — worker input. */
export type VoiceStreamingModelPaths =
	| { readonly kind: 'tone-ctc'; readonly model: string; readonly tokens: string }
	| { readonly kind: 'transducer'; readonly encoder: string; readonly decoder: string; readonly joiner: string; readonly tokens: string };

/** Offline (phrase re-decode) model descriptor with absolute file paths — worker input. */
export interface VoiceOfflineModelPaths {
	readonly kind: 'nemo-ctc';
	readonly model: string;
	readonly tokens: string;
}

/** Everything the worker needs to build recognizers for one session. */
export interface VoiceSessionModelPaths {
	readonly streaming: VoiceStreamingModelPaths;
	readonly offline?: VoiceOfflineModelPaths;
}

/** Session events pushed worker → main → renderer (single shape end to end). */
export type VoiceSessionEvent =
	| { readonly sessionId: string; readonly type: 'ready' }
	| { readonly sessionId: string; readonly type: 'partial'; readonly text: string }
	| { readonly sessionId: string; readonly type: 'final'; readonly text: string }
	| { readonly sessionId: string; readonly type: 'stopped' }
	| { readonly sessionId: string; readonly type: 'error'; readonly message: string };

/** Aggregated download progress for one profile (all its missing archives). */
export interface VoiceDownloadProgress {
	readonly profileId: VoiceProfileId;
	readonly receivedBytes: number;
	readonly totalBytes: number;
	readonly done: boolean;
	readonly error?: string;
}

export type VoiceProfileModelState = 'ready' | 'missing' | 'downloading';

export interface VoiceModelsState {
	readonly profiles: Record<VoiceProfileId, {
		readonly state: VoiceProfileModelState;
		/** Bytes still to download when `state` is not `ready` (sum of missing archives). */
		readonly downloadBytes: number;
	}>;
}

/** Renderer → main session start arguments. */
export interface VoiceStartSessionOptions {
	readonly sessionId: string;
	readonly profileId: VoiceProfileId;
}

// ── Worker protocol (main ⇄ utility process, structured clone) ────────────────

export type VoiceWorkerRequest =
	| {
		readonly t: 'start';
		readonly sessionId: string;
		readonly models: VoiceSessionModelPaths;
		readonly numThreads: number;
		readonly endpointSilenceMs: number;
	}
	/** 16 kHz mono PCM16 little-endian bytes (possibly unaligned — copy before viewing as Int16). */
	| { readonly t: 'audio'; readonly sessionId: string; readonly pcm: Uint8Array }
	/** Graceful stop: flush the tail, emit the last `final`, then `stopped`. */
	| { readonly t: 'stop'; readonly sessionId: string }
	/** Discard: no flush, just `stopped`. */
	| { readonly t: 'cancel'; readonly sessionId: string };

export type VoiceWorkerResponse = VoiceSessionEvent;
