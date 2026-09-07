/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Сколько токенов стоит изображение — выучивается из ответов провайдера, а не угадывается.
 *
 * WHY this cannot be a constant: the same screenshot costs about 1 100 tokens at one provider and
 * over 4 000 at a local vision model. A flat number is wrong in both directions, and wrong in the
 * expensive direction it is invisible: the estimate stays low, compaction never fires, and the
 * provider rejects the request that was too large all along. VibeIDE's own figure was 100 — an
 * order of magnitude below every real price, which matters because our screenshots come from
 * `/shot`, the design detector and inspect previews rather than once in a while.
 *
 * WHY it is observable at all: the provider prices every image on the very request that carries it,
 * so the cost shows up in `usage` with no vendor formula. Between two requests whose text is known,
 * the part of the growth in `prompt_tokens` that the text does not explain is what the new images
 * cost. Nothing here needs to know how any particular vendor tiles or scales an image.
 *
 * The method is taken from Hermes Agent (Apache-2.0, NousResearch/hermes-agent, commit be58c27),
 * which measured a flat estimate under-pricing its own protected context by 56.5% and the learned
 * one landing within 8.5%.
 */

/**
 * Пока ни одного изображения не отправлено.
 *
 * A deliberate over-estimate rather than the old 100: before the first measurement the only safe
 * error is «too expensive», which compacts a little early instead of failing the request outright.
 */
export const DEFAULT_IMAGE_TOKENS = 1_600;

/**
 * Bounds of belief. A measurement outside them is not a price — it is a mis-attributed jump, and
 * accepting it would poison every later estimate through the moving average.
 */
export const MIN_PLAUSIBLE_IMAGE_TOKENS = 50;
export const MAX_PLAUSIBLE_IMAGE_TOKENS = 20_000;

/** Weight of a new measurement. Low, because one odd request should nudge the belief, not replace it. */
const SMOOTHING = 0.3;

export interface ImageCostAnchor {
	/** `prompt_tokens` the provider reported for the previous request. */
	readonly promptTokens: number;
	/** Our own estimate of the text in that same request, in tokens. */
	readonly textTokens: number;
	/** How many images that request carried. */
	readonly images: number;
}

export interface ImageCostObservation {
	readonly promptTokens: number;
	readonly textTokens: number;
	readonly images: number;
}

/**
 * The price of one image implied by two consecutive requests, or `undefined` when they imply nothing.
 *
 * Читается так: рост `prompt_tokens`, не объяснённый ростом текста, поделить на число добавленных
 * изображений.
 */
export function inferImageCost(anchor: ImageCostAnchor, next: ImageCostObservation): number | undefined {
	const addedImages = next.images - anchor.images;
	if (addedImages <= 0) {
		// No new images means the growth says nothing about their price.
		return undefined;
	}
	const unexplained = (next.promptTokens - anchor.promptTokens) - (next.textTokens - anchor.textTokens);
	const perImage = unexplained / addedImages;
	if (!Number.isFinite(perImage) || perImage < MIN_PLAUSIBLE_IMAGE_TOKENS || perImage > MAX_PLAUSIBLE_IMAGE_TOKENS) {
		// Outside belief: the two requests differed in something we did not account for — a system
		// prompt change, a cache boundary, a tool schema. Better no measurement than a poisoned one.
		return undefined;
	}
	return perImage;
}

/**
 * Fold a fresh measurement into what is already believed.
 *
 * The first measurement is taken whole: the default is a guess, and one real number beats it
 * outright. After that the average moves slowly, because a single request can be unusual.
 */
export function blendImageCost(current: number | undefined, measured: number): number {
	if (current === undefined) {
		return Math.round(measured);
	}
	return Math.round(current * (1 - SMOOTHING) + measured * SMOOTHING);
}

/** Key under which a learned price is remembered: a price belongs to a model at a host, not to a model. */
export function imageCostKey(providerName: string, modelName: string): string {
	return `${providerName.toLowerCase()}::${modelName.toLowerCase()}`;
}

/**
 * Разделение сообщений на текст и изображения — для оценки, а не для отправки.
 *
 * WHY it is needed even before any learning: measuring the prompt by the length of its JSON counts
 * a base64 image as prose, so one screenshot reads as tens of thousands of tokens. That is the same
 * mistake as the flat 100 per image, only pointing the other way — and both make the budget wrong
 * for the same reason: an image is not text of its own length.
 *
 * Deliberately structural and dumb: it counts what looks like an image part in each shape we send,
 * and treats everything else as text. A part it does not recognise is counted as text, which errs
 * towards over-estimating rather than towards a request the provider will reject.
 */
export interface PromptShape {
	/** Characters of everything that is genuinely text. */
	readonly textChars: number;
	/** How many images the prompt carries. */
	readonly images: number;
}

interface UnknownPart {
	readonly type?: unknown;
	readonly text?: unknown;
	readonly image_url?: unknown;
	readonly inlineData?: unknown;
	readonly source?: unknown;
}

function isImagePart(part: UnknownPart): boolean {
	// The shapes we actually send: OpenAI (`image_url`), Anthropic (`type: 'image'` with a `source`),
	// Gemini (`inlineData`). `type: 'image'` alone already covers Anthropic's — the extra check for
	// its `source` that used to be here could never run, because the same condition had matched two
	// terms earlier.
	return part.type === 'image_url' || part.type === 'image' || !!part.image_url || !!part.inlineData;
}

/** Count text characters and images across a message list of any of our supported shapes. */
export function shapeOfPrompt(messages: readonly unknown[]): PromptShape {
	let textChars = 0;
	let images = 0;

	const walkContent = (content: unknown): void => {
		if (typeof content === 'string') {
			textChars += content.length;
			return;
		}
		if (!Array.isArray(content)) {
			return;
		}
		for (const raw of content) {
			const part = raw as UnknownPart;
			if (isImagePart(part)) {
				images++;
				continue;
			}
			if (typeof part?.text === 'string') {
				textChars += part.text.length;
				continue;
			}
			// Unrecognised: count its serialized size as text rather than pretend it is free.
			try {
				textChars += JSON.stringify(raw)?.length ?? 0;
			} catch {
				// Circular or unserializable — nothing sensible to add.
			}
		}
	};

	for (const raw of messages) {
		const message = raw as { content?: unknown; parts?: unknown };
		walkContent(message?.content);
		walkContent(message?.parts);
	}
	return { textChars, images };
}

/** Tokens a prompt is expected to cost: text by the usual ratio, images at the learned price. */
export function estimatePromptTokens(shape: PromptShape, imageTokens: number): number {
	return Math.ceil(shape.textChars / 4) + shape.images * imageTokens;
}
