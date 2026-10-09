/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { fuseRankings } from '../../../common/embeddings/rankFusion.js';

suite('rank fusion — words and meaning into one list', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('agreement wins, and a file only the meaning found still gets in', () => {
		const byWords = ['auth.ts', 'login.ts', 'readme.md'];
		const byMeaning = ['session.ts', 'auth.ts', 'token.ts'];
		assert.deepStrictEqual(fuseRankings([byWords, byMeaning], name => name), ['auth.ts', 'session.ts', 'login.ts', 'readme.md', 'token.ts']);
	});
});
