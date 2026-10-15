/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat mic button — pure state machine.
 * The phase is derived from the service state, the click action from the phase; the React button renders the phase
 * and dispatches the action, so none of the rules below live in a component.
 *
 * Why a click while the engine is transcribing does nothing:
 * the flush after a stop is bounded (main-side watchdog), and an impatient second click that cancels it throws the
 * dictated phrase away silently. The explicit cancel is Esc, named in the tooltip of the phase.
 */

import type { IVibeVoiceInputState } from './vibeVoiceInputService.js';

export type VoiceButtonPhase = 'hidden' | 'idle' | 'missing' | 'downloading' | 'recording' | 'transcribing';

export type VoiceButtonClickAction = 'start' | 'stop' | 'ignore';

export type VoiceButtonTooltip = 'start' | 'stop' | 'transcribing' | 'downloading' | 'missing';

type VoiceButtonStateInput = Pick<IVibeVoiceInputState, 'available' | 'recording' | 'transcribing' | 'modelState'>;

/** Recording and transcribing win over the model state: a live session means the models are already in place. */
export function resolveVoiceButtonPhase(state: VoiceButtonStateInput): VoiceButtonPhase {
	if (!state.available) {
		return 'hidden';
	}
	if (state.recording) {
		return 'recording';
	}
	if (state.transcribing) {
		return 'transcribing';
	}
	if (state.modelState === 'downloading') {
		return 'downloading';
	}
	return state.modelState === 'missing' ? 'missing' : 'idle';
}

/** `missing` starts too: the service answers a start without models with the download consent dialog. */
export function voiceButtonClickAction(phase: VoiceButtonPhase): VoiceButtonClickAction {
	switch (phase) {
		case 'recording':
			return 'stop';
		case 'idle':
		case 'missing':
			return 'start';
		default:
			return 'ignore';
	}
}

/** Esc is the explicit cancel, in both live phases. */
export function voiceButtonCancelsOnEscape(phase: VoiceButtonPhase): boolean {
	return phase === 'recording' || phase === 'transcribing';
}

export function voiceButtonTooltip(phase: VoiceButtonPhase): VoiceButtonTooltip {
	switch (phase) {
		case 'recording':
			return 'stop';
		case 'transcribing':
			return 'transcribing';
		case 'downloading':
			return 'downloading';
		case 'missing':
			return 'missing';
		default:
			return 'start';
	}
}
