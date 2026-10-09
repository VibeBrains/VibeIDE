/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseIndexResult } from '../../common/indexResult.js';

suite('repo index answer — file and lines back out of the text', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a range, a single line, and text that is not an answer', () => {
		assert.deepStrictEqual([
			parseIndexResult('File: /p/src/auth.ts:12-40\nSymbols: login\nContent preview:\nexport function login() {}'),
			parseIndexResult('File: /p/a b/c.ts:7\nContent preview:\nx'),
			parseIndexResult('some cached snippet'),
		], [
			{ path: '/p/src/auth.ts', startLine: 12, endLine: 40, preview: 'export function login() {}' },
			{ path: '/p/a b/c.ts', startLine: 7, endLine: 7, preview: 'x' },
			undefined,
		]);
	});
});
