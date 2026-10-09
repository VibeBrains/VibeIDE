/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Vectors for meaning search, fetched in the main process
 *
 * Here and not in the window: a cloud `/embeddings` answers a browser's cross-origin request with a refusal, and the main
 * process already routes every model call through the proxy the person configured
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { embeddingRequest, EmbeddingSourceConfig, parseEmbeddingResponse } from '../common/embeddings/embeddingSource.js';
import { foldPullLine, PullProgress, PullProgressEvent } from '../common/embeddings/ollamaPull.js';

/** One batch of fragments; the first call also waits for Ollama to load the model into memory */
const EMBED_TIMEOUT_MS = 120_000;
/** A download is given up only when Ollama goes silent this long: a slow line may take any time in total */
const PULL_STALL_MS = 120_000;

export type EmbedParams = { readonly config: EmbeddingSourceConfig; readonly inputs: readonly string[] };
export type PullParams = { readonly endpoint: string; readonly model: string };

async function postJson(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ status: number; json: unknown }> {
	const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
	const text = await response.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = { error: text.slice(0, 300) || `HTTP ${response.status}` };
	}
	return { status: response.status, json };
}

export class EmbeddingsChannel implements IServerChannel {

	private readonly _onPullProgress = new Emitter<PullProgressEvent>();

	listen<T>(_: unknown, event: string): Event<T> {
		if (event === 'onPullProgress') {
			return this._onPullProgress.event as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_: unknown, command: string, params: unknown): Promise<T> {
		if (command === 'embed') {
			return (await this._embed(params as EmbedParams)) as T;
		}
		if (command === 'pull') {
			await this._pull(params as PullParams);
			return undefined as T;
		}
		throw new Error(`Unknown command: ${command}`);
	}

	private async _embed({ config, inputs }: EmbedParams): Promise<number[][]> {
		if (inputs.length === 0) {
			return [];
		}
		// The key named by `apiKeyEnv` lives in this process's environment, as for the model calls
		const resolved: EmbeddingSourceConfig = config.kind === 'openai' && !config.apiKey && config.apiKeyEnv
			? { ...config, apiKey: process.env[config.apiKeyEnv] }
			: config;
		const request = embeddingRequest(resolved, inputs);
		const { status, json } = await postJson(request.url, { ...request.headers }, request.body, EMBED_TIMEOUT_MS);
		const parsed = parseEmbeddingResponse(config, inputs.length, json);
		if ('error' in parsed) {
			throw new Error(`HTTP ${status}: ${parsed.error}`);
		}
		return parsed.vectors;
	}

	/** Downloads an Ollama model, reporting progress; resolves when it is on disk */
	private async _pull({ endpoint, model }: PullParams): Promise<void> {
		const abort = new AbortController();
		let stall = setTimeout(() => abort.abort(), PULL_STALL_MS);
		const alive = () => {
			clearTimeout(stall);
			stall = setTimeout(() => abort.abort(), PULL_STALL_MS);
		};
		try {
			const response = await fetch(`${endpoint.replace(/\/+$/, '')}/api/pull`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model, stream: true }),
				signal: abort.signal,
			});
			if (!response.ok || !response.body) {
				throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300) || 'загрузка не удалась'}`);
			}
			const layers = new Map<string, { completed: number; total: number }>();
			const decoder = new TextDecoder();
			let buffered = '';
			let last: PullProgress | undefined;
			let reportedPercent = -1;
			for await (const chunk of response.body) {
				alive();
				buffered += decoder.decode(chunk, { stream: true });
				const lines = buffered.split('\n');
				buffered = lines.pop() ?? '';
				for (const line of lines) {
					last = foldPullLine(layers, line) ?? last;
					// Ollama writes several lines a second; the window needs a whole percent
					const percent = last && last.total > 0 ? Math.floor(last.completed * 100 / last.total) : -1;
					if (last && percent !== reportedPercent) {
						reportedPercent = percent;
						this._onPullProgress.fire({ ...last, model });
					}
				}
			}
			last = foldPullLine(layers, buffered) ?? last;
			if (last?.error) {
				throw new Error(last.error);
			}
			if (!last?.done) {
				throw new Error('Ollama оборвала загрузку');
			}
		} catch (error) {
			if (abort.signal.aborted) {
				throw new Error(`Ollama молчит дольше ${PULL_STALL_MS / 1000} с — загрузка прервана`);
			}
			throw error;
		} finally {
			clearTimeout(stall);
		}
	}
}
