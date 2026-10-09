/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { foldPullLine } from '../../../common/embeddings/ollamaPull.js';

suite('ollama model download — progress from the stream', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('layers add up, success ends, an error ends with its text, noise is skipped', () => {
		const layers = new Map<string, { completed: number; total: number }>();
		assert.deepStrictEqual([
			foldPullLine(layers, '{"status":"pulling manifest"}'),
			foldPullLine(layers, '{"status":"pulling a","digest":"a","total":600}'),
			foldPullLine(layers, '{"status":"pulling a","digest":"a","total":600,"completed":300}'),
			foldPullLine(layers, '{"status":"pulling b","digest":"b","total":100,"completed":100}'),
			foldPullLine(layers, ''),
			foldPullLine(layers, 'not json'),
			foldPullLine(layers, '{"status":"success"}'),
			foldPullLine(new Map(), '{"error":"pull model manifest: file does not exist"}'),
		], [
			{ completed: 0, total: 0, done: false },
			{ completed: 0, total: 600, done: false },
			{ completed: 300, total: 600, done: false },
			{ completed: 400, total: 700, done: false },
			undefined,
			undefined,
			{ completed: 400, total: 700, done: true },
			{ completed: 0, total: 0, done: true, error: 'pull model manifest: file does not exist' },
		]);
	});
});
