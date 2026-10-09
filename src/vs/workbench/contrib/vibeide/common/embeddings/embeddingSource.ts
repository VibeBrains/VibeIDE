/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where vectors for meaning search come from, and the two wire shapes that serve them — pure, no I/O
 *
 * Local Ollama by default: the code never leaves the machine, and VibeIDE already installs Ollama and pulls its models
 * An OpenAI-compatible `/embeddings` of a configured provider only by an explicit choice: then the code goes to the cloud
 */

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../../base/common/event.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';

export const EMBEDDINGS_PROVIDER_SETTING = 'vibeide.embeddings.provider';
export const EMBEDDINGS_MODEL_SETTING = 'vibeide.embeddings.model';

/** Small, multilingual, made for retrieval; the default Ollama model */
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'embeddinggemma';
/** OpenAI's own small embedding model; the default when the source is the built-in OpenAI provider */
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';

export type EmbeddingSourceConfig =
	| { readonly kind: 'ollama'; readonly endpoint: string; readonly model: string }
	| {
		readonly kind: 'openai';
		readonly baseURL: string;
		/** Absent for a server that takes no key; `apiKeyEnv` is resolved in the main process, like for the models */
		readonly apiKey?: string;
		readonly apiKeyEnv?: string;
		readonly headers?: Readonly<Record<string, string>>;
		readonly model: string;
	};

/**
 * The identity of the vectors: two vectors are comparable only when the same model made them
 * Stored next to every vector in the index, so a model switch never compares apples with oranges
 */
export function embeddingModelId(config: EmbeddingSourceConfig): string {
	return config.kind === 'ollama' ? `ollama/${config.model}` : `${config.baseURL.replace(/\/+$/, '')}/${config.model}`;
}

export interface EmbeddingRequest {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

export function embeddingRequest(config: EmbeddingSourceConfig, inputs: readonly string[]): EmbeddingRequest {
	if (config.kind === 'ollama') {
		return {
			url: `${config.endpoint.replace(/\/+$/, '')}/api/embed`,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: config.model, input: inputs, truncate: true }),
		};
	}
	return {
		url: `${config.baseURL.replace(/\/+$/, '')}/embeddings`,
		headers: { 'Content-Type': 'application/json', ...config.headers, ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {}) },
		body: JSON.stringify({ model: config.model, input: inputs }),
	};
}

function isVector(value: unknown): value is number[] {
	return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'number' && Number.isFinite(item));
}

/**
 * Vectors out of an answer, in input order, or the reason there are none
 * A count that does not match the inputs is an error, not a partial answer: a vector paired with the wrong text
 * Would put a file at the top of every search it has nothing to do with
 */
export function parseEmbeddingResponse(config: EmbeddingSourceConfig, inputCount: number, body: unknown): { vectors: number[][] } | { error: string } {
	const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
	let vectors: unknown[] | undefined;
	if (config.kind === 'ollama') {
		vectors = Array.isArray(record['embeddings']) ? record['embeddings'] : undefined;
	} else if (Array.isArray(record['data'])) {
		// The OpenAI shape carries an index per item; order by it rather than trusting the array order
		vectors = [...record['data'] as Array<Record<string, unknown>>]
			.sort((a, b) => Number(a?.['index'] ?? 0) - Number(b?.['index'] ?? 0))
			.map(item => item?.['embedding']);
	}
	if (!vectors) {
		const message = typeof record['error'] === 'string' ? record['error'] : (record['error'] as Record<string, unknown> | undefined)?.['message'];
		return { error: typeof message === 'string' ? message : 'ответ без векторов' };
	}
	if (vectors.length !== inputCount || !vectors.every(isVector)) {
		return { error: `векторов ${vectors.length} на ${inputCount} фрагментов, или они не числовые` };
	}
	const width = (vectors[0] as number[]).length;
	if (!vectors.every(vector => (vector as number[]).length === width)) {
		return { error: 'векторы разной длины' };
	}
	return { vectors: vectors as number[][] };
}

/** Ollama says this when the model has not been pulled */
export function isModelMissingError(message: string): boolean {
	return /model .*not found|try pulling it first|pull model/i.test(message);
}

export interface EmbeddingSourceState {
	/** Vectors can be made right now */
	readonly ready: boolean;
	/** `embeddingModelId` of the active source; empty when not ready */
	readonly modelId: string;
	/** What is missing, for the person: Ollama not running, model not pulled, provider without a key */
	readonly reason?: string;
}

export const IVibeEmbeddingsService = createDecorator<IVibeEmbeddingsService>('vibeEmbeddingsService');

/**
 * The single source of vectors for meaning search: the repo index, the semantic search command and similar-plan search
 * Implementation in `electron-browser/` — the HTTP call runs in the main process, behind the same proxy as the models
 */
export interface IVibeEmbeddingsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<void>;
	readonly state: EmbeddingSourceState;
	/** Vectors for the texts, in order, secrets redacted first; throws when the source is not ready or the call fails */
	embed(texts: readonly string[], token: CancellationToken): Promise<number[][]>;
}
