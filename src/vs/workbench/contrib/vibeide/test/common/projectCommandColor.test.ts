/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveProjectCommandColorId } from '../../common/projectCommandColor.js';

suite('Project Commands — color', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const registered = new Set(['terminal.ansiBlue', 'charts.red']);
	const resolve = (color: string | undefined) =>
		resolveProjectCommandColorId(color, id => registered.has(id));

	test('resolves registered ids, drops everything else', () => {
		assert.deepStrictEqual(
			{
				known: resolve('terminal.ansiBlue'),
				trimmed: resolve('  charts.red  '),
				unknown: resolve('terminal.ansiPuce'),
				literal: resolve('#ff0000'),
				css: resolve('red; background: url(x)'),
				single: resolve('red'),
				empty: resolve(''),
				missing: resolve(undefined),
			},
			{
				known: 'terminal.ansiBlue',
				trimmed: 'charts.red',
				unknown: undefined,
				literal: undefined,
				css: undefined,
				single: undefined,
				empty: undefined,
				missing: undefined,
			},
		);
	});
});
