/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIndexablePath } from '../../common/indexScope.js';
import { createIgnoreMatcher } from '../../common/vibeIgnore.js';

/**
 * Folders were skipped when their name appeared anywhere in the path: `out` dropped every `layout.ts`
 * A folder is excluded only as a whole segment from the project root, and the project's ignore rules decide the rest
 */
suite('repo index scope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a folder name inside a file name excludes nothing; whole segments and ignore rules do', () => {
		const ignore = createIgnoreMatcher('.claude/\n*.log\n!keep.log\n');
		const cases: ReadonlyArray<readonly [string, boolean]> = [
			['src/vs/browser/layout.ts', false],
			['src/timeout.ts', false],
			['src/builder/index.ts', false],
			['out/main.js', false],
			['src/node_modules/x/index.js', false],
			['.claude/worktrees/agent/src/a.ts', false],
			['.claude', true],
			['src/app.py', false],
			['README.md', false],
			['src/image.png', false],
			['../outside.ts', false],
		];
		assert.deepStrictEqual(
			cases.map(([path, isDirectory]) => `${path} ${isIndexablePath(path, isDirectory, ignore)}`),
			[
				'src/vs/browser/layout.ts true',
				'src/timeout.ts true',
				'src/builder/index.ts true',
				'out/main.js false',
				'src/node_modules/x/index.js false',
				'.claude/worktrees/agent/src/a.ts false',
				'.claude false',
				'src/app.py true',
				'README.md true',
				'src/image.png false',
				'../outside.ts false',
			],
		);
	});
});
