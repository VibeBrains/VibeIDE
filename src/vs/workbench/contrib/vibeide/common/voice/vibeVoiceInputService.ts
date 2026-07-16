/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input — renderer facade contract. Implementation is desktop-only
 * (`electron-browser/voice/vibeVoiceInputService.ts`, wired via `workbench.desktop.main.ts`):
 * it owns mic capture, the STT provider registered into the upstream `ISpeechService`
 * (which powers editor/terminal dictation) and the model download flow. This facade is
 * what the React chat consumes for its mic button.
 */

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export const IVibeVoiceInputService = createDecorator<IVibeVoiceInputService>('vibeVoiceInputService');

export type VoiceInputModelState = 'ready' | 'missing' | 'downloading';

export interface IVibeVoiceInputState {
	/** False when the feature is disabled (`vibeide.voice.enabled`) — UI should hide. */
	readonly available: boolean;
	readonly recording: boolean;
	readonly modelState: VoiceInputModelState;
	/** Bytes to download for the current language profile (shown before first use). */
	readonly downloadBytes: number;
	/** 0..100 while `modelState` is `downloading`. */
	readonly downloadPercent: number;
}

export interface IVibeVoiceTextEvent {
	/** `interim` — live preview, replaces the previous interim; `final` — committed phrase. */
	readonly kind: 'interim' | 'final';
	readonly text: string;
}

export interface IVibeVoiceInputService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<IVibeVoiceInputState>;
	/** Recognized text of the active dictation session (chat facade sessions only). */
	readonly onText: Event<IVibeVoiceTextEvent>;
	/** Mic level 0..1 while recording — drives the button pulse. */
	readonly onLevel: Event<number>;

	getState(): IVibeVoiceInputState;

	/**
	 * Start a chat dictation session. When models are missing, kicks off the download
	 * (with progress notification) instead — the user starts dictation again afterwards.
	 */
	start(): Promise<void>;

	/** Graceful stop: flush the tail of speech into a last `final`, then end. */
	stop(): void;

	/** Abort: discard any pending audio, end immediately. */
	cancel(): void;
}
