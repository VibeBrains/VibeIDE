/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	blendImageCost, DEFAULT_IMAGE_TOKENS, estimatePromptTokens, imageCostKey, inferImageCost,
	MAX_PLAUSIBLE_IMAGE_TOKENS, MIN_PLAUSIBLE_IMAGE_TOKENS, shapeOfPrompt,
} from '../../common/imageTokenCost.js';

/**
 * Цена изображения, выученная из ответов провайдера.
 *
 * The failure this replaces is silent: with a price ten times too low the context estimate stays
 * small, compaction never fires, and the provider rejects a request that was over the limit from the
 * start. So the tests pin the two things that make the measurement trustworthy — that it is derived
 * only from what the provider itself reported, and that an implausible number is refused rather than
 * averaged in.
 */
suite('image token cost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the price is what the text growth does not explain', () => {
		// Text grew by 500 tokens, the prompt by 3 700, one image appeared → the image cost 3 200.
		const measured = inferImageCost(
			{ promptTokens: 10_000, textTokens: 9_000, images: 0 },
			{ promptTokens: 13_700, textTokens: 9_500, images: 1 },
		);
		assert.strictEqual(measured, 3_200);
	});

	test('two images at once are priced per image', () => {
		assert.strictEqual(inferImageCost(
			{ promptTokens: 1_000, textTokens: 1_000, images: 0 },
			{ promptTokens: 3_400, textTokens: 1_000, images: 2 },
		), 1_200);
	});

	test('a pair that added no image measures nothing', () => {
		const anchor = { promptTokens: 5_000, textTokens: 4_000, images: 1 };
		assert.deepStrictEqual([
			inferImageCost(anchor, { promptTokens: 6_000, textTokens: 5_000, images: 1 }),
			// Fewer images than before: the request was compacted, and the arithmetic no longer holds.
			inferImageCost(anchor, { promptTokens: 3_000, textTokens: 2_800, images: 0 }),
		], [undefined, undefined]);
	});

	/**
	 * The guard that matters most: a jump caused by something else — a changed system prompt, a cache
	 * boundary, a new tool schema — must not be recorded as the price of an image, because the moving
	 * average would carry that error into every later estimate.
	 */
	test('an implausible measurement is refused, not averaged in', () => {
		const anchor = { promptTokens: 1_000, textTokens: 1_000, images: 0 };
		assert.deepStrictEqual({
			слишкомДёшево: inferImageCost(anchor, { promptTokens: 1_010, textTokens: 1_000, images: 1 }),
			слишкомДорого: inferImageCost(anchor, { promptTokens: 60_000, textTokens: 1_000, images: 1 }),
			отрицательный: inferImageCost(anchor, { promptTokens: 900, textTokens: 1_000, images: 1 }),
			наНижнейГранице: inferImageCost(anchor, { promptTokens: 1_000 + MIN_PLAUSIBLE_IMAGE_TOKENS, textTokens: 1_000, images: 1 }),
			наВерхнейГранице: inferImageCost(anchor, { promptTokens: 1_000 + MAX_PLAUSIBLE_IMAGE_TOKENS, textTokens: 1_000, images: 1 }),
		}, {
			слишкомДёшево: undefined,
			слишкомДорого: undefined,
			отрицательный: undefined,
			наНижнейГранице: MIN_PLAUSIBLE_IMAGE_TOKENS,
			наВерхнейГранице: MAX_PLAUSIBLE_IMAGE_TOKENS,
		});
	});

	test('the first measurement replaces the guess, later ones only move it', () => {
		const first = blendImageCost(undefined, 4_000);
		assert.strictEqual(first, 4_000, 'одно настоящее число лучше догадки целиком');
		// A single odd request nudges the belief instead of overwriting it.
		assert.strictEqual(blendImageCost(4_000, 1_000), 3_100);
		assert.strictEqual(blendImageCost(4_000, 4_000), 4_000);
	});

	test('a price belongs to a model at a host, not to a model', () => {
		assert.notStrictEqual(imageCostKey('minimax', 'm3'), imageCostKey('openrouter', 'm3'));
		assert.strictEqual(imageCostKey('MiniMax', 'M3'), imageCostKey('minimax', 'm3'));
	});

	/** The default is deliberately high: before any measurement, «too expensive» is the safe error. */
	test('the default errs towards compacting early', () => {
		assert.ok(DEFAULT_IMAGE_TOKENS > 1_000);
		assert.ok(DEFAULT_IMAGE_TOKENS < MAX_PLAUSIBLE_IMAGE_TOKENS);
	});

	/**
	 * The other half of the same bug: measuring a prompt by the length of its JSON counts a base64
	 * screenshot as prose, so one image reads as tens of thousands of tokens. Both mistakes make the
	 * budget wrong for one reason — an image is not text of its own length.
	 */
	test('a base64 image is counted as one image, not as its own length', () => {
		const base64 = 'data:image/png;base64,' + 'A'.repeat(200_000);
		const shape = shapeOfPrompt([
			{ role: 'user', content: [{ type: 'text', text: 'посмотри на скриншот' }, { type: 'image_url', image_url: { url: base64 } }] },
		]);
		assert.deepStrictEqual(shape, { textChars: 'посмотри на скриншот'.length, images: 1 });

		// 200 KB of base64 would have read as ~50 000 tokens; at a learned price it is 1 200.
		assert.strictEqual(estimatePromptTokens(shape, 1_200), Math.ceil(20 / 4) + 1_200);
	});

	/** Anthropic's shape is `type: 'image'` with a `source`; it must count once, not slip through. */
	test('every shape we send is recognised', () => {
		const shapes = shapeOfPrompt([
			{ role: 'user', content: 'просто текст' },
			{ role: 'user', content: [{ type: 'image', source: { data: 'x' } }] },
			{ role: 'user', parts: [{ inlineData: { data: 'y' } }, { text: 'подпись' }] },
		]);
		assert.deepStrictEqual(shapes, { textChars: 'просто текст'.length + 'подпись'.length, images: 2 });
	});

	/** An unfamiliar part is charged as text: over-estimating is recoverable, a rejected call is not. */
	test('an unrecognised part is counted rather than treated as free', () => {
		const shape = shapeOfPrompt([{ role: 'user', content: [{ type: 'audio', payload: 'abcdef' }] }]);
		assert.ok(shape.textChars > 0);
		assert.strictEqual(shape.images, 0);
	});
});
