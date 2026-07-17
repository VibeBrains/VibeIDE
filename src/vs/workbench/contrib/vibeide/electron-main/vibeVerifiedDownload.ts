/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Streaming HTTPS download with on-the-fly SHA256 verification — shared by the main-process
 * artifact stores (STT models in `voice/vibeVoiceMainService.ts`, video tools in
 * `video/vibeVideoMainService.ts`). Extracted verbatim from the voice service once the video
 * pipeline became the second consumer. Plain functions, not a service: no state, and the
 * callers are electron-main singletons constructed outside DI.
 */

import { createWriteStream } from 'fs';
import { createHash } from 'crypto';

/**
 * Download `url` into `filePath`, verifying the SHA256 of the received bytes as they stream.
 * Rejects (leaving the partial file for the caller's cleanup) on any network error or digest
 * mismatch. `onChunk` reports raw received byte counts for progress aggregation.
 */
export async function downloadWithSha256(url: string, filePath: string, expectedHex: string, onChunk: (bytes: number) => void): Promise<void> {
	const res = await followRedirectGet(url, 0);
	const hash = createHash('sha256');
	await new Promise<void>((resolve, reject) => {
		const out = createWriteStream(filePath);
		res.on('data', (c: Buffer | string) => {
			const buf = typeof c === 'string' ? Buffer.from(c) : c;
			hash.update(buf);
			onChunk(buf.byteLength);
			if (!out.write(buf)) {
				res.pause();
				out.once('drain', () => res.resume());
			}
		});
		res.on('end', () => out.end());
		res.on('error', reject);
		out.on('error', reject);
		out.on('finish', () => {
			const digest = hash.digest('hex');
			if (digest.toLowerCase() !== expectedHex.toLowerCase()) {
				reject(new Error('SHA256 mismatch'));
			} else {
				resolve();
			}
		});
	});
}

/** GET following up to 10 redirects (GitHub release assets bounce through the CDN). */
export async function followRedirectGet(urlStr: string, depth: number): Promise<import('http').IncomingMessage> {
	if (depth > 10) {
		throw new Error('Too many redirects');
	}
	const https = await import('https');
	return new Promise((resolve, reject) => {
		https.get(urlStr, { headers: { 'User-Agent': 'VibeIDE-ArtifactDownload', 'Accept': '*/*' } }, res => {
			if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				const next = new URL(res.headers.location, urlStr).href;
				followRedirectGet(next, depth + 1).then(resolve, reject);
				return;
			}
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
				return;
			}
			resolve(res);
		}).on('error', reject);
	});
}
