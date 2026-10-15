/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input — where a phrase ends.
 *
 * Pure apart from the two decoders it is given, so the order of drafts and phrases is tested without a model.
 *
 * T-one in sherpa-onnx 1.13.4 does not close a phrase at a pause: pauses of 1.5 to 3 s between phrases left them
 * in one piece, and the built-in endpoint came only about 5.7 s after the speech (measured 15.10.2026 on JVM and
 * in Node on synthetic speech).
 * So a phrase ends here: when the text of the streaming model has not changed for `endpointSilenceSeconds` of audio
 * after something was heard, or at the length cap. The model's own endpoint still counts, for the models that report it.
 *
 * Silence with nothing heard does not end a phrase. The built-in rule for it (5 s) cut a word at the start of speech:
 * the model shows a word about a second after it starts (0.97 s on synthetic speech), and by then the counter of silence
 * had already run out and reset the stream. Here the buffer of silence is only trimmed to a short pre-roll, and the stream is left alone.
 *
 * The same pause rule is in VibeIDEA (`PhraseSplitter` in SherpaEngine.kt): a phrase must close at the same pause
 * in both IDEs.
 */

/** A phrase is made final at this length even without a pause, so the buffer of a monologue cannot grow without end. */
export const VOICE_MAX_PHRASE_SECONDS = 28;

/** Silence appended on a graceful stop, enough for the streaming model to see the end of the last word. */
export const VOICE_TAIL_SILENCE_SECONDS = 0.6;

/** Silence with nothing heard is trimmed at this length, so a microphone left open holds no minutes of silence. */
export const VOICE_IDLE_SILENCE_SECONDS = 5;

/**
 * What is kept of the silence before speech: more than the streaming model needs to show the first word (about a second).
 * Not much more: GigaAM made more mistakes on phrases with two or more seconds of silence before them.
 */
export const VOICE_PREROLL_SECONDS = 1.5;

/** What a phrase is made of while it is spoken: the seam between the phrase logic and the native recognizer. */
export interface StreamingDecoder {
	/** Feeds the samples and decodes everything that became ready. */
	accept(samples: Float32Array): void;
	/** The text of the phrase so far. */
	text(): string;
	/** The model itself heard the phrase end. */
	endpoint(): boolean;
	/** Starts the next phrase. */
	reset(): void;
}

/** Decodes one finished phrase again; the text that stays. */
export type PhraseDecoder = (samples: Float32Array) => string;

export interface PhraseEvent {
	/** `partial` is a draft that may change; `final` is a finished phrase. */
	readonly type: 'partial' | 'final';
	readonly text: string;
}

export interface PhraseSplitterOptions {
	readonly sampleRate: number;
	/** The pause after speech at which a phrase counts as said (`vibeide.voice.endpointSilenceMs`). */
	readonly endpointSilenceSeconds: number;
}

/**
 * The phrases of one recording: drafts while they are spoken, the final text when each ends.
 * Not thread-safe: one caller feeds it.
 */
export class PhraseSplitter {
	/** Audio of the current (unfinished) phrase: input of the second decode. */
	private segmentChunks: Float32Array[] = [];
	private segmentSamples = 0;
	private draft = '';

	/** Samples heard since the phrase began, the silence of the stop included. */
	private heard = 0;
	/** `heard` when the text of the streaming model last changed, and that text as it came. */
	private changedAt = 0;
	private raw = '';

	constructor(
		private readonly streaming: StreamingDecoder,
		private readonly finalDecoder: PhraseDecoder | undefined,
		private readonly options: PhraseSplitterOptions,
		private readonly emit: (event: PhraseEvent) => void,
	) { }

	/** `keep` is false for silence that is not part of the phrase: it advances the clock but is not decoded again. */
	accept(samples: Float32Array, keep = true): void {
		if (keep) {
			this.segmentChunks.push(samples);
			this.segmentSamples += samples.length;
		}
		this.heard += samples.length;
		this.streaming.accept(samples);
		const now = this.streaming.text();
		if (now !== this.raw) {
			this.raw = now;
			this.changedAt = this.heard;
		}
		const text = now.trim();
		if (text && text !== this.draft) {
			this.draft = text;
			this.emit({ type: 'partial', text });
		}
		if (this.ended()) {
			this.endPhrase();
		} else {
			this.trimIdle();
		}
	}

	/** The recording is over: a short silence lets the streaming model settle, and the last phrase is made final. */
	flush(): void {
		this.accept(new Float32Array(Math.round(VOICE_TAIL_SILENCE_SECONDS * this.options.sampleRate)), false);
		this.endPhrase();
	}

	private ended(): boolean {
		const rate = this.options.sampleRate;
		const quiet = this.heard - this.changedAt;
		return this.streaming.endpoint()
			|| (this.raw.trim() !== '' && quiet >= this.options.endpointSilenceSeconds * rate)
			|| this.segmentSamples >= VOICE_MAX_PHRASE_SECONDS * rate;
	}

	/** Nothing heard for a long stretch: keep only the pre-roll in the buffer. The stream and the clock stay as they are. */
	private trimIdle(): void {
		const rate = this.options.sampleRate;
		if (this.raw.trim() !== '' || this.segmentSamples < VOICE_IDLE_SILENCE_SECONDS * rate) {
			return;
		}
		const keep = VOICE_PREROLL_SECONDS * rate;
		while (this.segmentChunks.length > 1 && this.segmentSamples - this.segmentChunks[0].length >= keep) {
			this.segmentSamples -= this.segmentChunks.shift()!.length;
		}
	}

	private endPhrase(): void {
		const decoded = this.finalDecoder && this.segmentSamples > 0 ? this.finalDecoder(this.joined()).trim() : '';
		// The second model can come back empty on a phrase the streaming one heard: the draft is then better than nothing
		const text = decoded || this.draft;
		if (text) {
			this.emit({ type: 'final', text });
		}
		this.streaming.reset();
		this.segmentChunks = [];
		this.segmentSamples = 0;
		this.draft = '';
		this.heard = 0;
		this.changedAt = 0;
		this.raw = '';
	}

	private joined(): Float32Array {
		const out = new Float32Array(this.segmentSamples);
		let offset = 0;
		for (const chunk of this.segmentChunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}
}
