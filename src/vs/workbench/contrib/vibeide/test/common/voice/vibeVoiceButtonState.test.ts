/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resolveVoiceButtonPhase, voiceButtonCancelsOnEscape, voiceButtonClickAction, voiceButtonTooltip, VoiceButtonPhase } from '../../../common/voice/vibeVoiceButtonState.js';

const base = { available: true, recording: false, transcribing: false, modelState: 'ready' as const };

suite('Voice input — mic button state machine', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('phase follows the service state, a live session wins over the model state', () => {
		assert.deepStrictEqual({
			disabled: resolveVoiceButtonPhase({ ...base, available: false, recording: true }),
			idle: resolveVoiceButtonPhase(base),
			missing: resolveVoiceButtonPhase({ ...base, modelState: 'missing' }),
			downloading: resolveVoiceButtonPhase({ ...base, modelState: 'downloading' }),
			recording: resolveVoiceButtonPhase({ ...base, recording: true }),
			transcribing: resolveVoiceButtonPhase({ ...base, transcribing: true }),
			recordingOverDownload: resolveVoiceButtonPhase({ ...base, recording: true, modelState: 'downloading' }),
			transcribingOverMissing: resolveVoiceButtonPhase({ ...base, transcribing: true, modelState: 'missing' }),
		}, {
			disabled: 'hidden',
			idle: 'idle',
			missing: 'missing',
			downloading: 'downloading',
			recording: 'recording',
			transcribing: 'transcribing',
			recordingOverDownload: 'recording',
			transcribingOverMissing: 'transcribing',
		});
	});

	test('a click while transcribing or downloading is ignored, never a silent cancel', () => {
		const phases: VoiceButtonPhase[] = ['hidden', 'idle', 'missing', 'downloading', 'recording', 'transcribing'];
		assert.deepStrictEqual(Object.fromEntries(phases.map(p => [p, voiceButtonClickAction(p)])), {
			hidden: 'ignore',
			idle: 'start',
			missing: 'start',
			downloading: 'ignore',
			recording: 'stop',
			transcribing: 'ignore',
		});
	});

	test('the explicit cancel (Esc) is armed in both live phases only', () => {
		const phases: VoiceButtonPhase[] = ['hidden', 'idle', 'missing', 'downloading', 'recording', 'transcribing'];
		assert.deepStrictEqual(phases.filter(voiceButtonCancelsOnEscape), ['recording', 'transcribing']);
	});

	test('every phase has the tooltip of its own', () => {
		const phases: VoiceButtonPhase[] = ['idle', 'missing', 'downloading', 'recording', 'transcribing'];
		assert.deepStrictEqual(phases.map(voiceButtonTooltip), ['start', 'missing', 'downloading', 'stop', 'transcribing']);
	});

	test('the whole dictation walks idle → recording → transcribing → idle through the click rule', () => {
		let state = { ...base };
		const walk: string[] = [];
		const click = () => {
			const action = voiceButtonClickAction(resolveVoiceButtonPhase(state));
			walk.push(action);
			if (action === 'start') { state = { ...state, recording: true }; }
			if (action === 'stop') { state = { ...state, recording: false, transcribing: true }; }
		};
		click(); // start
		click(); // stop
		click(); // impatient click on the transcribing button
		click(); // and another one
		const stillTranscribing = resolveVoiceButtonPhase(state);
		state = { ...state, transcribing: false }; // `Stopped` arrives
		assert.deepStrictEqual({ walk, stillTranscribing, after: resolveVoiceButtonPhase(state) }, {
			walk: ['start', 'stop', 'ignore', 'ignore'],
			stillTranscribing: 'transcribing',
			after: 'idle',
		});
	});
});
