/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { AgentReadRules, agentMayReadByRules } from '../../common/agentReadPolicy.js';

suite('agentReadPolicy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Search results and diff files go through one answer: any of the three rule sets closes a file. */
	test('.vibe/ignore, the constraints and the permissions each close a file on their own', () => {
		const rules: AgentReadRules = {
			ignore: { isIgnored: uri => uri.path.endsWith('/ignored.txt') },
			constraints: { checkReadAllowed: path => { if (path.endsWith('/secret.env')) { throw new Error('запрещено'); } } },
			permissions: { canRead: path => !path.endsWith('/denied.md') },
		};
		const may = (name: string) => agentMayReadByRules(URI.file(`/project/${name}`), rules);
		assert.deepStrictEqual(
			[may('src/a.ts'), may('ignored.txt'), may('secret.env'), may('denied.md')],
			[true, false, false, false],
		);
	});
});
