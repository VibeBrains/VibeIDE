/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { embeddingModelId, embeddingRequest, EmbeddingSourceConfig, isModelMissingError, parseEmbeddingResponse } from '../../../common/embeddings/embeddingSource.js';

/** A vector paired with the wrong text puts a file at the top of every search it has nothing to do with */
suite('embedding source — wire shapes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ollama: EmbeddingSourceConfig = { kind: 'ollama', endpoint: 'http://127.0.0.1:11434/', model: 'embeddinggemma' };
	const openai: EmbeddingSourceConfig = { kind: 'openai', baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'text-embedding-3-small' };

	test('requests, model identity and answers of both shapes; a short or ragged answer is an error', () => {
		assert.deepStrictEqual({
			ollamaUrl: embeddingRequest(ollama, ['a']).url,
			ollamaBody: JSON.parse(embeddingRequest(ollama, ['a', 'b']).body),
			openaiUrl: embeddingRequest(openai, ['a']).url,
			auth: embeddingRequest(openai, ['a']).headers['Authorization'],
			ids: [embeddingModelId(ollama), embeddingModelId(openai)],
			ollamaOk: parseEmbeddingResponse(ollama, 2, { embeddings: [[1, 2], [3, 4]] }),
			openaiReordered: parseEmbeddingResponse(openai, 2, { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] }),
			short: 'error' in parseEmbeddingResponse(ollama, 2, { embeddings: [[1, 2]] }),
			ragged: 'error' in parseEmbeddingResponse(ollama, 2, { embeddings: [[1, 2], [3]] }),
			vendorError: parseEmbeddingResponse(ollama, 1, { error: 'model "embeddinggemma" not found, try pulling it first' }),
			missing: isModelMissingError('model "embeddinggemma" not found, try pulling it first'),
		}, {
			ollamaUrl: 'http://127.0.0.1:11434/api/embed',
			ollamaBody: { model: 'embeddinggemma', input: ['a', 'b'], truncate: true },
			openaiUrl: 'https://api.example.com/v1/embeddings',
			auth: 'Bearer k',
			ids: ['ollama/embeddinggemma', 'https://api.example.com/v1/text-embedding-3-small'],
			ollamaOk: { vectors: [[1, 2], [3, 4]] },
			openaiReordered: { vectors: [[1, 2], [3, 4]] },
			short: true,
			ragged: true,
			vendorError: { error: 'model "embeddinggemma" not found, try pulling it first' },
			missing: true,
		});
	});
});
