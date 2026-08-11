/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	LocalModelFit,
	estimateLocalModelFit,
	kvCacheBytes,
	parseModelShape,
	parseTrainedContext,
	formatGigabytes,
	estimateWeightsFromTag,
} from '../../common/localModelFit.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const GB = 1024 ** 3;

/** Llama 3 8B: 32 layers, 32 query heads, 8 kv heads (GQA), embedding 4096 → head_dim 128. */
const LLAMA3_8B = { layers: 32, kvHeads: 8, headDim: 128 };

suite('localModelFit', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('kvCacheBytes', () => {
		test('grouped-query attention is what makes long context affordable', () => {
			// 2 × 32 × 8 × 128 × 8192 × 2 = 1 073 741 824 bytes exactly.
			assert.strictEqual(kvCacheBytes(LLAMA3_8B, 8192), 1 * GB);
		});

		test('cache grows linearly with context — the term that decides 4k vs 128k', () => {
			const at4k = kvCacheBytes(LLAMA3_8B, 4096);
			const at128k = kvCacheBytes(LLAMA3_8B, 131072);
			assert.strictEqual(at128k, at4k * 32);
		});

		test('same size, no GQA: four times the cache — why estimating from weights fails', () => {
			const noGqa = { ...LLAMA3_8B, kvHeads: 32 };
			assert.strictEqual(kvCacheBytes(noGqa, 8192), kvCacheBytes(LLAMA3_8B, 8192) * 4);
		});

		test('degenerate shapes yield zero rather than NaN', () => {
			assert.deepStrictEqual(
				[
					kvCacheBytes({ layers: 0, kvHeads: 8, headDim: 128 }, 8192),
					kvCacheBytes({ layers: 32, kvHeads: 0, headDim: 128 }, 8192),
					kvCacheBytes({ layers: 32, kvHeads: 8, headDim: 0 }, 8192),
					kvCacheBytes(LLAMA3_8B, 0),
				],
				[0, 0, 0, 0]);
		});
	});

	suite('estimateLocalModelFit', () => {
		test('8B at 8k on a 32 GB machine — comfortable', () => {
			const r = estimateLocalModelFit({
				weightsBytes: 4.7 * GB, totalMemoryBytes: 32 * GB, contextTokens: 8192, shape: LLAMA3_8B,
			});
			assert.strictEqual(r.fit, LocalModelFit.Fits);
		});

		test('the same model at 128k stops fitting — context, not weights, is the problem', () => {
			const at8k = estimateLocalModelFit({
				weightsBytes: 4.7 * GB, totalMemoryBytes: 16 * GB, contextTokens: 8192, shape: LLAMA3_8B,
			});
			const at128k = estimateLocalModelFit({
				weightsBytes: 4.7 * GB, totalMemoryBytes: 16 * GB, contextTokens: 131072, shape: LLAMA3_8B,
			});
			assert.deepStrictEqual(
				[at8k.fit, at128k.fit],
				[LocalModelFit.Fits, LocalModelFit.TooLarge]);
		});

		test('weights alone over memory — too large even without the cache', () => {
			const r = estimateLocalModelFit({
				weightsBytes: 40 * GB, totalMemoryBytes: 16 * GB, contextTokens: 4096, shape: LLAMA3_8B,
			});
			assert.strictEqual(r.fit, LocalModelFit.TooLarge);
		});

		test('fits arithmetically but leaves nothing for the machine', () => {
			const r = estimateLocalModelFit({
				weightsBytes: 11 * GB, totalMemoryBytes: 16 * GB, contextTokens: 8192, shape: LLAMA3_8B,
			});
			assert.strictEqual(r.fit, LocalModelFit.Tight);
		});

		test('without the attention shape a fitting model is «unknown», not «fits»', () => {
			const r = estimateLocalModelFit({
				weightsBytes: 4.7 * GB, totalMemoryBytes: 32 * GB, contextTokens: 8192,
			});
			assert.deepStrictEqual(
				{ fit: r.fit, kv: r.kvCacheBytes },
				{ fit: LocalModelFit.Unknown, kv: 0 });
		});

		test('but weights over memory is still answerable without the shape', () => {
			const r = estimateLocalModelFit({
				weightsBytes: 40 * GB, totalMemoryBytes: 16 * GB, contextTokens: 8192,
			});
			assert.strictEqual(r.fit, LocalModelFit.TooLarge);
		});

		test('missing inputs are «unknown», never a confident zero', () => {
			assert.deepStrictEqual(
				[
					estimateLocalModelFit({ weightsBytes: 0, totalMemoryBytes: 16 * GB, contextTokens: 8192 }).fit,
					estimateLocalModelFit({ weightsBytes: 4 * GB, totalMemoryBytes: 0, contextTokens: 8192 }).fit,
				],
				[LocalModelFit.Unknown, LocalModelFit.Unknown]);
		});
	});

	suite('parseModelShape', () => {
		test('keys are architecture-prefixed, so the prefix has to be read first', () => {
			assert.deepStrictEqual(parseModelShape({
				'general.architecture': 'llama',
				'llama.block_count': 32,
				'llama.embedding_length': 4096,
				'llama.attention.head_count': 32,
				'llama.attention.head_count_kv': 8,
			}), LLAMA3_8B);
		});

		test('another architecture, same code path', () => {
			assert.deepStrictEqual(parseModelShape({
				'general.architecture': 'qwen3',
				'qwen3.block_count': 64,
				'qwen3.embedding_length': 5120,
				'qwen3.attention.head_count': 40,
				'qwen3.attention.head_count_kv': 8,
			}), { layers: 64, kvHeads: 8, headDim: 128 });
		});

		test('no GQA key: every query head carries its own pair', () => {
			assert.deepStrictEqual(parseModelShape({
				'general.architecture': 'gpt2',
				'gpt2.block_count': 12,
				'gpt2.embedding_length': 768,
				'gpt2.attention.head_count': 12,
			}), { layers: 12, kvHeads: 12, headDim: 64 });
		});

		test('missing, malformed and unusable payloads all yield undefined', () => {
			assert.deepStrictEqual(
				[
					parseModelShape(undefined),
					parseModelShape({}),
					parseModelShape({ 'llama.block_count': 32 }),
					parseModelShape({ 'general.architecture': 'llama', 'llama.block_count': 32 }),
					parseModelShape({
						'general.architecture': 'llama',
						'llama.block_count': '32',
						'llama.embedding_length': 4096,
						'llama.attention.head_count': 32,
					}),
				],
				[undefined, undefined, undefined, undefined, undefined]);
		});
	});

	suite('parseTrainedContext', () => {
		test('reported context window, also architecture-prefixed', () => {
			assert.strictEqual(parseTrainedContext({
				'general.architecture': 'llama',
				'llama.context_length': 8192,
			}), 8192);
		});

		test('absent or unusable — undefined', () => {
			assert.deepStrictEqual(
				[
					parseTrainedContext(undefined),
					parseTrainedContext({ 'general.architecture': 'llama' }),
					parseTrainedContext({ 'general.architecture': 'llama', 'llama.context_length': 0 }),
				],
				[undefined, undefined, undefined]);
		});
	});

	suite('estimateWeightsFromTag', () => {
		test('sizes in the tag land close to the published downloads', () => {
			const gb = (tag: string) => (estimateWeightsFromTag(tag)! / 1024 ** 3).toFixed(1);
			// Published Q4_K_M sizes: 8B ≈ 4.7 GB, 13B ≈ 8.0 GB, 70B ≈ 40 GB.
			assert.deepStrictEqual(
				[gb('llama3:8b'), gb('llava:13b'), gb('llama3:70b')],
				['4.4', '7.1', '38.3']);
		});

		test('fractional sizes are read too', () => {
			assert.ok(estimateWeightsFromTag('llama3.2:3.2b')! > 0);
		});

		test('no size in the tag — undefined, so the caller stays silent', () => {
			assert.deepStrictEqual(
				[
					estimateWeightsFromTag('llama3'),
					estimateWeightsFromTag('mixtral'),
					estimateWeightsFromTag('llama3:latest'),
					estimateWeightsFromTag(''),
					estimateWeightsFromTag('weird:0b'),
				],
				[undefined, undefined, undefined, undefined, undefined]);
		});

		test('version digits in the name are not mistaken for a size', () => {
			assert.strictEqual(estimateWeightsFromTag('qwen2.5-coder'), undefined);
		});
	});

	test('formatGigabytes — one decimal, comma as the separator', () => {
		assert.deepStrictEqual(
			[formatGigabytes(4.7 * GB), formatGigabytes(GB), formatGigabytes(0)],
			['4,7 ГБ', '1,0 ГБ', '0,0 ГБ']);
	});
});
