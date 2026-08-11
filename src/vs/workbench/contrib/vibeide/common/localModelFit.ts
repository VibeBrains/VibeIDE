/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * Will this local model actually run on this machine?
 *
 * VibeIDE offers to install Ollama on startup and can pull a model by tag, so the user can spend
 * tens of gigabytes of traffic before finding out their machine cannot hold the thing. This module
 * answers the question up front.
 *
 * The arithmetic is deliberately *not* the one found in the popular VRAM calculators, which
 * approximate the KV cache as a share of the model weights (`weights × 0.2 × ctx / 2048` and the
 * like). That relation does not hold: the KV cache depends on the attention shape, not on total
 * size, and every current model ships grouped-query attention that cuts `head_count_kv` four- to
 * eightfold. Estimating from weights overstates the cache several times over on exactly the models
 * people run locally.
 *
 * We do not have to guess. Ollama reports the real architecture (`/api/show` → `model_info`) and
 * the real file size (`/api/tags` → `size`), so both terms are measured rather than modelled.
 */

/** Bytes an entry of the KV cache takes. Ollama keeps the cache in f16 unless told otherwise. */
const KV_BYTES_PER_ELEMENT = 2;

/** Keys and values are cached separately — hence two. */
const KV_TENSORS_PER_LAYER = 2;

/**
 * Compute graph, activations and the runtime's own buffers, as a share of weights plus cache.
 * Deliberately modest: this is a warning, and overstating it would cry wolf on machines that cope.
 */
const RUNTIME_OVERHEAD = 1.08;

/**
 * Above this share of total memory the model technically fits but leaves nothing for the editor,
 * the browser and the OS, so it swaps and crawls. Measured against total rather than free memory
 * on purpose: free memory swings minute to minute, and a verdict that changes while you read it
 * is worse than a slightly conservative one.
 */
const TIGHT_FIT_RATIO = 0.75;

export const enum LocalModelFit {
	/** Comfortably within memory. */
	Fits = 'fits',
	/** Fits arithmetically, but leaves too little for everything else. */
	Tight = 'tight',
	/** Does not fit — it will offload to disk, if it starts at all. */
	TooLarge = 'tooLarge',
	/** Not enough information to judge. Saying nothing beats guessing. */
	Unknown = 'unknown',
}

/** Attention shape needed for an honest KV-cache figure. */
export interface IModelShape {
	/** Transformer layers (`<arch>.block_count`). */
	readonly layers: number;
	/** Key/value heads (`<arch>.attention.head_count_kv`) — the GQA-reduced count, not the query heads. */
	readonly kvHeads: number;
	/** Size of a single head: `embedding_length / attention.head_count`. */
	readonly headDim: number;
}

export interface ILocalModelFitInput {
	/** Size of the model on disk, in bytes (`/api/tags` → `size`). Weights dominate the total. */
	readonly weightsBytes: number;
	/** Total machine memory, in bytes. */
	readonly totalMemoryBytes: number;
	/** Context the model will be run with, in tokens. */
	readonly contextTokens: number;
	/** Attention shape; absent when the model has not been pulled yet and cannot be inspected. */
	readonly shape?: IModelShape;
}

export interface ILocalModelFitResult {
	readonly fit: LocalModelFit;
	/** Total memory the model is expected to need, in bytes. */
	readonly requiredBytes: number;
	/** The KV-cache share of it, in bytes — zero when the attention shape is unknown. */
	readonly kvCacheBytes: number;
	/** Share of machine memory the model would take, 0..n. */
	readonly memoryShare: number;
}

/**
 * KV cache for a full context window:
 *
 *   2 (keys and values) × layers × kv_heads × head_dim × tokens × bytes_per_element
 *
 * This is the term that decides whether a model that fits at 4k still fits at 128k — and the one
 * the user has no way to work out on their own.
 */
export function kvCacheBytes(shape: IModelShape, contextTokens: number): number {
	if (shape.layers <= 0 || shape.kvHeads <= 0 || shape.headDim <= 0 || contextTokens <= 0) {
		return 0;
	}
	return KV_TENSORS_PER_LAYER * shape.layers * shape.kvHeads * shape.headDim
		* contextTokens * KV_BYTES_PER_ELEMENT;
}

/** Estimates whether the model fits, and by how much. */
export function estimateLocalModelFit(input: ILocalModelFitInput): ILocalModelFitResult {
	const { weightsBytes, totalMemoryBytes, contextTokens, shape } = input;

	if (weightsBytes <= 0 || totalMemoryBytes <= 0) {
		return { fit: LocalModelFit.Unknown, requiredBytes: 0, kvCacheBytes: 0, memoryShare: 0 };
	}

	// Without the attention shape the cache term is missing, so the total is a floor, not an
	// estimate. It still answers the loudest case — weights alone exceeding memory.
	const cache = shape ? kvCacheBytes(shape, contextTokens) : 0;
	const requiredBytes = Math.round((weightsBytes + cache) * RUNTIME_OVERHEAD);
	const memoryShare = requiredBytes / totalMemoryBytes;

	let fit: LocalModelFit;
	if (memoryShare > 1) {
		fit = LocalModelFit.TooLarge;
	} else if (!shape) {
		// Weights fit, but the cache is unaccounted for and grows with context — the honest answer
		// is that we do not know, not that everything is fine.
		fit = LocalModelFit.Unknown;
	} else if (memoryShare > TIGHT_FIT_RATIO) {
		fit = LocalModelFit.Tight;
	} else {
		fit = LocalModelFit.Fits;
	}

	return { fit, requiredBytes, kvCacheBytes: cache, memoryShare };
}

/**
 * Reads the attention shape out of `/api/show` → `model_info`.
 *
 * The keys are prefixed with the architecture (`llama.block_count`, `qwen3.attention.head_count_kv`),
 * so they cannot be looked up by a fixed name — the prefix comes from `general.architecture`.
 */
export function parseModelShape(modelInfo: Readonly<Record<string, unknown>> | undefined): IModelShape | undefined {
	if (!modelInfo) {
		return undefined;
	}

	const architecture = modelInfo['general.architecture'];
	if (typeof architecture !== 'string' || !architecture) {
		return undefined;
	}

	const num = (suffix: string): number | undefined => {
		const value = modelInfo[`${architecture}.${suffix}`];
		return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
	};

	const layers = num('block_count');
	const embedding = num('embedding_length');
	const heads = num('attention.head_count');
	// Models without grouped-query attention omit the key: every query head carries its own
	// key/value pair, so the count equals `head_count`.
	const kvHeads = num('attention.head_count_kv') ?? heads;

	if (!layers || !embedding || !heads || !kvHeads) {
		return undefined;
	}

	return { layers, kvHeads, headDim: embedding / heads };
}

/** Context window the model was trained for, when reported — the default we measure against. */
export function parseTrainedContext(modelInfo: Readonly<Record<string, unknown>> | undefined): number | undefined {
	if (!modelInfo) {
		return undefined;
	}
	const architecture = modelInfo['general.architecture'];
	if (typeof architecture !== 'string' || !architecture) {
		return undefined;
	}
	const value = modelInfo[`${architecture}.context_length`];
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Bits per parameter of Ollama's default quantization (`Q4_K_M`), which is what a `pull` without an
 * explicit tag suffix gets. Not a flat four: the scheme keeps some tensors at higher precision.
 * Checked against published sizes — 8B → ~4.7 GB, 70B → ~40 GB.
 */
const DEFAULT_QUANT_BITS_PER_PARAM = 4.7;

/**
 * Weight of a model that has **not been pulled yet**, worked out from its tag (`llava:13b`).
 *
 * This is the only thing honestly knowable before a download: `/api/show` answers for installed
 * models only. Tags without a size (`llama3`, `mixtral`) return undefined, and the caller stays
 * silent — a warning invented from nothing is worse than no warning. Note that no KV cache is
 * involved here, so the estimate can only ever answer «the weights alone do not fit».
 */
export function estimateWeightsFromTag(tag: string): number | undefined {
	const match = /:(\d+(?:\.\d+)?)b\b/i.exec(tag);
	if (!match) {
		return undefined;
	}
	const billions = Number(match[1]);
	if (!Number.isFinite(billions) || billions <= 0) {
		return undefined;
	}
	return billions * 1e9 * (DEFAULT_QUANT_BITS_PER_PARAM / 8);
}

/** «12,4 ГБ» — one decimal is as much precision as an estimate deserves. */
export function formatGigabytes(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ`;
}

/**
 * One sentence for the user: what it needs, what there is, and what that means in practice.
 * Phrased as an expectation rather than a verdict — the estimate is good, but it is an estimate.
 */
export function describeLocalModelFit(result: ILocalModelFitResult, totalMemoryBytes: number, contextTokens: number): string {
	const required = formatGigabytes(result.requiredBytes);
	const total = formatGigabytes(totalMemoryBytes);

	switch (result.fit) {
		case LocalModelFit.TooLarge:
			return localize('vibeide.localModelFit.tooLarge',
				"Модели нужно около {0} при контексте {1} токенов, а на машине {2}. Скорее всего она не запустится или будет выгружаться на диск и работать очень медленно.",
				required, contextTokens, total);
		case LocalModelFit.Tight:
			return localize('vibeide.localModelFit.tight',
				"Модели нужно около {0} при контексте {1} токенов — это почти вся память машины ({2}). Запустится, но на редактор и браузер почти ничего не останется.",
				required, contextTokens, total);
		case LocalModelFit.Fits:
			return localize('vibeide.localModelFit.fits',
				"Модели нужно около {0} при контексте {1} токенов, на машине {2} — должна работать свободно.",
				required, contextTokens, total);
		default:
			return localize('vibeide.localModelFit.unknown',
				"Не удалось оценить, поместится ли модель: не хватает данных о её устройстве.");
	}
}
