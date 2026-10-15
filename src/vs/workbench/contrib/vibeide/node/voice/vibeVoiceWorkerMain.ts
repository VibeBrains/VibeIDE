/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input — STT utility-process entry point (`vs/workbench/contrib/vibeide/node/voice/
 * vibeVoiceWorkerMain`). Spawned by `electron-main/voice/vibeVoiceMainService.ts`; speaks
 * `VoiceWorkerRequest`/`VoiceWorkerResponse` over `process.parentPort`.
 *
 * Runs sherpa-onnx (native N-API addon) OUTSIDE electron-main on purpose: decoding is a
 * synchronous native call and a crash here must not take the IDE down. The hybrid pipeline:
 * the streaming model emits interim text; `PhraseSplitter` decides where a phrase ends (the model's
 * own endpoint, or the text standing still for `endpointSilenceMs` — T-one does not close a phrase at a pause);
 * each finished phrase is re-decoded from a buffer by the offline model (RU: GigaAM,
 * noticeably better WER) for the `final` event. Profiles without an offline model promote
 * the last interim to `final`.
 */

import { isUtilityProcess, ParentPort } from '../../../../../base/parts/sandbox/node/electronTypes.js';
import { VoiceSessionModelPaths, VoiceStreamingModelPaths, VoiceOfflineModelPaths, VoiceWorkerRequest, VoiceWorkerResponse, VOICE_SAMPLE_RATE } from '../../common/voice/vibeVoiceTypes.js';
import { PhraseSplitter, StreamingDecoder } from '../../common/voice/vibePhraseSplitter.js';

// ── Minimal typings for the sherpa-onnx-node CJS module (no upstream .d.ts) ──

interface SherpaOnlineStream {
	acceptWaveform(chunk: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaOnlineRecognizer {
	createStream(): SherpaOnlineStream;
	isReady(stream: SherpaOnlineStream): boolean;
	decode(stream: SherpaOnlineStream): void;
	isEndpoint(stream: SherpaOnlineStream): boolean;
	reset(stream: SherpaOnlineStream): void;
	getResult(stream: SherpaOnlineStream): { text: string };
}

interface SherpaOfflineStream {
	acceptWaveform(chunk: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaOfflineRecognizer {
	createStream(): SherpaOfflineStream;
	decode(stream: SherpaOfflineStream): void;
	getResult(stream: SherpaOfflineStream): { text: string };
}

interface SherpaApi {
	OnlineRecognizer: new (config: object) => SherpaOnlineRecognizer;
	OfflineRecognizer: new (config: object) => SherpaOfflineRecognizer;
}

let sherpaPromise: Promise<SherpaApi> | undefined;
function loadSherpa(): Promise<SherpaApi> {
	sherpaPromise ??= import('sherpa-onnx-node').then(mod => ((mod as { default?: unknown }).default ?? mod) as SherpaApi);
	return sherpaPromise;
}

// ── Engine (recognizers are expensive — cache per model/threads/endpoint config) ──

/** Value that switches a built-in endpoint rule off: no recording has a silence or an utterance this long. */
const BUILTIN_RULE_OFF_SECONDS = 1e9;

function onlineModelConfig(streaming: VoiceStreamingModelPaths, numThreads: number): object {
	if (streaming.kind === 'tone-ctc') {
		return { toneCtc: { model: streaming.model }, tokens: streaming.tokens, numThreads, provider: 'cpu', debug: 0 };
	}
	return {
		transducer: { encoder: streaming.encoder, decoder: streaming.decoder, joiner: streaming.joiner },
		tokens: streaming.tokens,
		numThreads,
		provider: 'cpu',
		debug: 0,
	};
}

class VoiceEngine {
	readonly key: string;
	readonly online: SherpaOnlineRecognizer;
	readonly offline: SherpaOfflineRecognizer | undefined;

	constructor(sherpa: SherpaApi, models: VoiceSessionModelPaths, numThreads: number, endpointSilenceMs: number) {
		this.key = VoiceEngine.keyOf(models, numThreads, endpointSilenceMs);
		this.online = new sherpa.OnlineRecognizer({
			modelConfig: onlineModelConfig(models.streaming, numThreads),
			enableEndpoint: true,
			// Only rule2 (trailing silence after speech, the user-facing "phrase ended" knob) is left to the model.
			// Rules 1 (silence with nothing decoded) and 3 (utterance length) count from the last reset, not from
			// speech: they fired in the first second of a word, before the model had shown it, and cut it.
			// `PhraseSplitter` has the cap, and silence before speech needs no phrase at all.
			rule1MinTrailingSilence: BUILTIN_RULE_OFF_SECONDS,
			rule2MinTrailingSilence: endpointSilenceMs / 1000,
			rule3MinUtteranceLength: BUILTIN_RULE_OFF_SECONDS,
		});
		this.offline = models.offline ? VoiceEngine.createOffline(sherpa, models.offline, numThreads) : undefined;
	}

	private static createOffline(sherpa: SherpaApi, offline: VoiceOfflineModelPaths, numThreads: number): SherpaOfflineRecognizer {
		return new sherpa.OfflineRecognizer({
			featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
			modelConfig: { nemoCtc: { model: offline.model }, tokens: offline.tokens, numThreads, provider: 'cpu', debug: 0 },
		});
	}

	static keyOf(models: VoiceSessionModelPaths, numThreads: number, endpointSilenceMs: number): string {
		return JSON.stringify({ models, numThreads, endpointSilenceMs });
	}
}

let engine: VoiceEngine | undefined;

async function ensureEngine(models: VoiceSessionModelPaths, numThreads: number, endpointSilenceMs: number): Promise<VoiceEngine> {
	const key = VoiceEngine.keyOf(models, numThreads, endpointSilenceMs);
	if (!engine || engine.key !== key) {
		engine = new VoiceEngine(await loadSherpa(), models, numThreads, endpointSilenceMs);
	}
	return engine;
}

// ── Batch decode (video /watch transcript fallback) ─────────────────────────
// Separate recognizer cache: batch requests carry only the offline model, and reusing the
// session engine would needlessly key the cache on streaming/endpoint parameters.

let batchRecognizer: { key: string; recognizer: SherpaOfflineRecognizer } | undefined;

async function ensureBatchRecognizer(offline: VoiceOfflineModelPaths, numThreads: number): Promise<SherpaOfflineRecognizer> {
	const key = JSON.stringify({ offline, numThreads });
	if (!batchRecognizer || batchRecognizer.key !== key) {
		const sherpa = await loadSherpa();
		batchRecognizer = {
			key,
			recognizer: new sherpa.OfflineRecognizer({
				featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
				modelConfig: { nemoCtc: { model: offline.model }, tokens: offline.tokens, numThreads, provider: 'cpu', debug: 0 },
			}),
		};
	}
	return batchRecognizer.recognizer;
}

/** PCM16 little-endian bytes → Float32 samples (structured clone may misalign the view). */
function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
	const aligned = pcm.byteOffset % 2 === 0
		? new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1)
		: new Int16Array(pcm.slice().buffer, 0, pcm.byteLength >> 1);
	const samples = new Float32Array(aligned.length);
	for (let i = 0; i < aligned.length; i++) {
		samples[i] = aligned[i] / 32768;
	}
	return samples;
}

async function decodeBatchChunk(offline: VoiceOfflineModelPaths, numThreads: number, pcm: Uint8Array): Promise<string> {
	const recognizer = await ensureBatchRecognizer(offline, numThreads);
	const stream = recognizer.createStream();
	stream.acceptWaveform({ sampleRate: VOICE_SAMPLE_RATE, samples: pcm16ToFloat32(pcm) });
	recognizer.decode(stream);
	return recognizer.getResult(stream).text.trim();
}

// ── Session ──────────────────────────────────────────────────────────────────

/** The native streaming recognizer behind the seam `PhraseSplitter` works against. */
class OnlineDecoder implements StreamingDecoder {
	constructor(private readonly recognizer: SherpaOnlineRecognizer, private readonly stream: SherpaOnlineStream) { }

	accept(samples: Float32Array): void {
		this.stream.acceptWaveform({ sampleRate: VOICE_SAMPLE_RATE, samples });
		while (this.recognizer.isReady(this.stream)) {
			this.recognizer.decode(this.stream);
		}
	}

	text(): string {
		return this.recognizer.getResult(this.stream).text;
	}

	endpoint(): boolean {
		return this.recognizer.isEndpoint(this.stream);
	}

	reset(): void {
		this.recognizer.reset(this.stream);
	}
}

/** Re-decode a finished phrase with the offline model (higher accuracy). */
function decodePhraseOffline(offline: SherpaOfflineRecognizer, samples: Float32Array): string {
	const stream = offline.createStream();
	stream.acceptWaveform({ sampleRate: VOICE_SAMPLE_RATE, samples });
	offline.decode(stream);
	return offline.getResult(stream).text;
}

class VoiceSession {
	private readonly splitter: PhraseSplitter;

	constructor(
		private readonly sessionId: string,
		engine: VoiceEngine,
		endpointSilenceMs: number,
		private readonly post: (msg: VoiceWorkerResponse) => void,
	) {
		const offline = engine.offline;
		this.splitter = new PhraseSplitter(
			new OnlineDecoder(engine.online, engine.online.createStream()),
			offline ? samples => decodePhraseOffline(offline, samples) : undefined,
			{ sampleRate: VOICE_SAMPLE_RATE, endpointSilenceSeconds: endpointSilenceMs / 1000 },
			event => post({ sessionId, type: event.type, text: event.text }),
		);
	}

	pushPcm16(pcm: Uint8Array): void {
		this.splitter.accept(pcm16ToFloat32(pcm));
	}

	/** Graceful stop: settle the decoder with a silence tail, flush the last phrase. */
	stop(): void {
		this.splitter.flush();
		this.post({ sessionId: this.sessionId, type: 'stopped' });
	}

	cancel(): void {
		this.post({ sessionId: this.sessionId, type: 'stopped' });
	}
}

// ── Message loop ─────────────────────────────────────────────────────────────

function main(parentPort: ParentPort): void {
	const sessions = new Map<string, VoiceSession>();
	const post = (msg: VoiceWorkerResponse) => parentPort.postMessage(msg);

	parentPort.on('message', async e => {
		const msg = e.data as VoiceWorkerRequest;
		if (msg.t === 'decodeBatch') {
			// Session-less path with its own error envelope — a failed chunk must not fabricate
			// session events for an empty sessionId.
			try {
				post({ type: 'batchResult', requestId: msg.requestId, text: await decodeBatchChunk(msg.offline, msg.numThreads, msg.pcm) });
			} catch (error) {
				post({ type: 'batchResult', requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		try {
			switch (msg.t) {
				case 'start': {
					const eng = await ensureEngine(msg.models, msg.numThreads, msg.endpointSilenceMs);
					sessions.set(msg.sessionId, new VoiceSession(msg.sessionId, eng, msg.endpointSilenceMs, post));
					post({ sessionId: msg.sessionId, type: 'ready' });
					break;
				}
				case 'audio':
					sessions.get(msg.sessionId)?.pushPcm16(msg.pcm);
					break;
				case 'stop':
					sessions.get(msg.sessionId)?.stop();
					sessions.delete(msg.sessionId);
					break;
				case 'cancel':
					sessions.get(msg.sessionId)?.cancel();
					sessions.delete(msg.sessionId);
					break;
			}
		} catch (error) {
			// eslint-disable-next-line local/code-no-in-operator -- narrowing on an untyped worker message; `in` narrows, hasOwn does not
			const sessionId = 'sessionId' in msg ? msg.sessionId : '';
			sessions.delete(sessionId);
			post({ sessionId, type: 'error', message: error instanceof Error ? error.message : String(error) });
			post({ sessionId, type: 'stopped' });
		}
	});
}

if (isUtilityProcess(process)) {
	main(process.parentPort);
} else {
	throw new Error('vibeVoiceWorkerMain must run inside an Electron utility process');
}
