/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	PhraseEvent,
	PhraseSplitter,
	StreamingDecoder,
	VOICE_IDLE_SILENCE_SECONDS,
	VOICE_MAX_PHRASE_SECONDS,
	VOICE_TAIL_SILENCE_SECONDS,
} from '../../../common/voice/vibePhraseSplitter.js';

const RATE = 16000;
const ENDPOINT_SILENCE_SECONDS = 0.8;

/** A streaming decoder that answers `drafts` one per accepted chunk and hears the end of a phrase where `ends` says. */
class Script implements StreamingDecoder {
	chunks = 0;
	resets = 0;
	readonly heard: number[] = [];

	constructor(private readonly drafts: readonly string[], private readonly ends: ReadonlySet<number> = new Set()) { }

	accept(samples: Float32Array): void {
		this.heard.push(samples.length);
		this.chunks++;
	}

	text(): string {
		return this.drafts[this.chunks - 1] ?? this.drafts[this.drafts.length - 1] ?? '';
	}

	endpoint(): boolean {
		return this.ends.has(this.chunks);
	}

	reset(): void {
		this.resets++;
	}
}

function splitterOf(streaming: StreamingDecoder, finalDecoder: ((samples: Float32Array) => string) | undefined, said: PhraseEvent[]): PhraseSplitter {
	return new PhraseSplitter(streaming, finalDecoder, { sampleRate: RATE, endpointSilenceSeconds: ENDPOINT_SILENCE_SECONDS }, event => said.push(event));
}

suite('Voice input — where a phrase ends', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('drafts are said once each as they change, and the end of a phrase gives the final model text', () => {
		const said: PhraseEvent[] = [];
		const decoded: number[] = [];
		const streaming = new Script(['п', 'привет', 'привет', 'привет ми'], new Set([4]));
		const splitter = splitterOf(streaming, samples => { decoded.push(samples.length); return 'привет мир'; }, said);
		for (let i = 0; i < 4; i++) {
			splitter.accept(new Float32Array(100));
		}
		assert.deepStrictEqual({ said, decoded, resets: streaming.resets }, {
			said: [
				{ type: 'partial', text: 'п' },
				{ type: 'partial', text: 'привет' },
				{ type: 'partial', text: 'привет ми' },
				{ type: 'final', text: 'привет мир' },
			],
			decoded: [400],
			resets: 1,
		});
	});

	test('the stop settles the streaming model with silence that is not part of the phrase, and ends the last phrase', () => {
		const said: PhraseEvent[] = [];
		const decoded: number[] = [];
		const streaming = new Script(['готово']);
		const splitter = splitterOf(streaming, samples => { decoded.push(samples.length); return 'готово'; }, said);
		splitter.accept(new Float32Array(800));
		splitter.flush();
		assert.deepStrictEqual({
			finals: said.filter(e => e.type === 'final'),
			tail: streaming.heard[streaming.heard.length - 1],
			decoded,
		}, {
			finals: [{ type: 'final', text: 'готово' }],
			tail: VOICE_TAIL_SILENCE_SECONDS * RATE,
			decoded: [800],
		});
	});

	test('without a final model the last draft is the phrase, and an empty final text falls back to it too', () => {
		const alone: PhraseEvent[] = [];
		splitterOf(new Script(['hello world'], new Set([1])), undefined, alone).accept(new Float32Array(10));
		const silent: PhraseEvent[] = [];
		splitterOf(new Script(['слово'], new Set([1])), () => '', silent).accept(new Float32Array(10));
		assert.deepStrictEqual({ alone: alone[alone.length - 1], silent: silent[silent.length - 1] }, {
			alone: { type: 'final', text: 'hello world' },
			silent: { type: 'final', text: 'слово' },
		});
	});

	test('silence that ends a phrase with nothing heard says nothing', () => {
		const said: PhraseEvent[] = [];
		const splitter = splitterOf(new Script([''], new Set([1])), () => '', said);
		splitter.accept(new Float32Array(10));
		splitter.flush();
		assert.deepStrictEqual(said, []);
	});

	test('a monologue is cut into phrases at the cap even when no pause comes', () => {
		// The text grows every second, as it does while somebody speaks without a break
		const said: PhraseEvent[] = [];
		const streaming = new Script(Array.from({ length: VOICE_MAX_PHRASE_SECONDS }, (_, i) => 'слово '.repeat(i + 1)));
		const splitter = splitterOf(streaming, () => 'кусок', said);
		const second = new Float32Array(RATE);
		for (let i = 0; i < VOICE_MAX_PHRASE_SECONDS - 1; i++) {
			splitter.accept(second);
		}
		const resetsBeforeCap = streaming.resets;
		splitter.accept(second);
		assert.deepStrictEqual({ resetsBeforeCap, last: said[said.length - 1], resets: streaming.resets }, {
			resetsBeforeCap: 0,
			last: { type: 'final', text: 'кусок' },
			resets: 1,
		});
	});

	test('a pause after speech ends the phrase even when the model never reports an endpoint, as T-one does not', () => {
		const said: PhraseEvent[] = [];
		const streaming = new Script(['открой', 'открой файл', 'открой файл', 'открой файл', 'открой файл']);
		const splitter = splitterOf(streaming, () => 'открой файл', said);
		const tenth = new Float32Array(RATE / 10);
		splitter.accept(tenth);
		splitter.accept(tenth);
		const pause = new Float32Array(ENDPOINT_SILENCE_SECONDS * RATE / 2);
		splitter.accept(pause);
		const finalsAtHalfPause = said.filter(e => e.type === 'final').length;
		splitter.accept(pause);
		assert.deepStrictEqual({ finalsAtHalfPause, last: said[said.length - 1], resets: streaming.resets }, {
			finalsAtHalfPause: 0,
			last: { type: 'final', text: 'открой файл' },
			resets: 1,
		});
	});

	test('the pause is counted from the last change of the text, not from the start of the phrase', () => {
		const said: PhraseEvent[] = [];
		// The text keeps growing for three seconds, then stands still
		const drafts = ['раз', 'раз два', 'раз два три'];
		const streaming = new Script(drafts);
		const splitter = splitterOf(streaming, () => 'раз два три', said);
		const second = new Float32Array(RATE);
		for (let i = 0; i < drafts.length; i++) {
			splitter.accept(second);
		}
		const finalsWhileSpeaking = said.filter(e => e.type === 'final').length;
		splitter.accept(new Float32Array(ENDPOINT_SILENCE_SECONDS * RATE));
		assert.deepStrictEqual({ finalsWhileSpeaking, last: said[said.length - 1] }, {
			finalsWhileSpeaking: 0,
			last: { type: 'final', text: 'раз два три' },
		});
	});

	test('a custom pause length moves the point where the phrase closes', () => {
		const said: PhraseEvent[] = [];
		const splitter = new PhraseSplitter(new Script(['слово']), () => 'слово', { sampleRate: RATE, endpointSilenceSeconds: 2 }, event => said.push(event));
		splitter.accept(new Float32Array(RATE));
		splitter.accept(new Float32Array(RATE));
		const finalsAfterOneSecondOfPause = said.filter(e => e.type === 'final').length;
		splitter.accept(new Float32Array(RATE));
		assert.deepStrictEqual({ finalsAfterOneSecondOfPause, last: said[said.length - 1] }, {
			finalsAfterOneSecondOfPause: 0,
			last: { type: 'final', text: 'слово' },
		});
	});

	test('a long stretch with nothing heard is trimmed to a pre-roll, and the stream is not reset under a word that may be starting', () => {
		const said: PhraseEvent[] = [];
		// Six seconds of silence, then the model shows a word and hears the end of the phrase
		const streaming = new Script(['', '', '', '', '', '', 'слово'], new Set([7]));
		const decoded: number[] = [];
		const splitter = splitterOf(streaming, samples => { decoded.push(samples.length); return 'слово'; }, said);
		for (let i = 0; i < VOICE_IDLE_SILENCE_SECONDS + 1; i++) {
			splitter.accept(new Float32Array(RATE));
		}
		const resetsInSilence = streaming.resets;
		splitter.accept(new Float32Array(RATE));
		assert.deepStrictEqual({ resetsInSilence, said, decoded, resets: streaming.resets }, {
			resetsInSilence: 0,
			said: [{ type: 'partial', text: 'слово' }, { type: 'final', text: 'слово' }],
			// The silence before the word is cut down to the pre-roll (whole chunks: two of one second for 1.5 s) plus what came after the trim, not all seven seconds
			decoded: [4 * RATE],
			resets: 1,
		});
	});

	test('silence is not trimmed while the model shows text: a pause inside a phrase keeps its audio', () => {
		const said: PhraseEvent[] = [];
		const streaming = new Script(['слово']);
		const decoded: number[] = [];
		const splitter = new PhraseSplitter(streaming, samples => { decoded.push(samples.length); return 'слово'; }, { sampleRate: RATE, endpointSilenceSeconds: 20 }, event => said.push(event));
		for (let i = 0; i < VOICE_IDLE_SILENCE_SECONDS + 2; i++) {
			splitter.accept(new Float32Array(RATE));
		}
		splitter.flush();
		assert.deepStrictEqual(decoded, [(VOICE_IDLE_SILENCE_SECONDS + 2) * RATE]);
	});
});
