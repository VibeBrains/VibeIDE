/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { decodeVectorFile, encodeVectorFile, textsStamp, truncateVector, unitCosine } from '../../../common/embeddings/vectorFile.js';

suite('repo index vectors — size, identity, file', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a cut vector is unit length; a file survives the round trip; a broken file is no file; a stamp follows the text', () => {
		const a = truncateVector([3, 4, 12], 2);
		const b = truncateVector([4, 3, 0], 2);
		const encoded = encodeVectorFile({ modelId: 'ollama/embeddinggemma', dims: 2, files: new Map([['/p/a.ts', { stamp: 's1', vectors: [a, b] }], ['/p/b.ts', { stamp: 's2', vectors: [b] }]]) });
		const decoded = decodeVectorFile(encoded)!;
		const round = (n: number) => Math.round(n * 1000) / 1000;
		assert.deepStrictEqual({
			cut: [...a].map(round),
			cosine: round(unitCosine(a, b)),
			model: decoded.modelId,
			files: [...decoded.files.entries()].map(([path, file]) => `${path} ${file.stamp} ${file.vectors.map(vector => [...vector].map(round).join('/')).join(' ')}`),
			broken: decodeVectorFile(encoded.slice(0, encoded.length - 3)),
			garbage: decodeVectorFile(new Uint8Array([1, 2, 3])),
			sameStamp: textsStamp(['x', 'y']) === textsStamp(['x', 'y']),
			changedStamp: textsStamp(['x', 'y']) === textsStamp(['x', 'z']),
		}, {
			cut: [0.6, 0.8],
			cosine: 0.96,
			model: 'ollama/embeddinggemma',
			files: ['/p/a.ts s1 0.6/0.8 0.8/0.6', '/p/b.ts s2 0.8/0.6'],
			broken: undefined,
			garbage: undefined,
			sameStamp: true,
			changedStamp: false,
		});
	});
});
