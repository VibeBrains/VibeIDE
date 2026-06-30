/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Minimal WAV (RIFF / PCM 16-bit) encoder. Pure, dependency-free — the notification-sound editor
// trims a clip into mono Float32 samples (via OfflineAudioContext) and encodes them here for saving.
// Mono keeps a 5-second clip well under the 1 MB acceptance limit (44.1kHz·16-bit·5s ≈ 441 KB).

const WAV_HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

/** Encode mono PCM samples (range [-1, 1]) as a 16-bit WAV file. */
export function encodeWavPcm16Mono(samples: Float32Array, sampleRate: number): Uint8Array {
	const dataBytes = samples.length * (BITS_PER_SAMPLE / 8);
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
	const view = new DataView(buffer);

	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) { view.setUint8(offset + i, text.charCodeAt(i)); }
	};

	const byteRate = sampleRate * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
	const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);

	// RIFF chunk descriptor
	writeAscii(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true); // file size minus the first 8 bytes
	writeAscii(8, 'WAVE');
	// "fmt " sub-chunk
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true);            // PCM fmt chunk size
	view.setUint16(20, 1, true);             // audio format = PCM
	view.setUint16(22, NUM_CHANNELS, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, BITS_PER_SAMPLE, true);
	// "data" sub-chunk
	writeAscii(36, 'data');
	view.setUint32(40, dataBytes, true);

	// PCM samples — clamp to [-1, 1] then scale to signed 16-bit.
	let offset = WAV_HEADER_BYTES;
	for (let i = 0; i < samples.length; i++) {
		const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
		view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		offset += 2;
	}

	return new Uint8Array(buffer);
}
