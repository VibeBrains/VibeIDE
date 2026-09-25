/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decideSlopGate, prosePaths, slopGateModeOf } from '../../common/textSlop/slopGatePolicy.js';

/** The turn gate of the neural-slop detector — the same modes, default and prose files as VibeIDEA's SlopGatePolicy */
suite('slop gate policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prose is found by extension, case-insensitive, once each, in the order written', () => {
		assert.deepStrictEqual(
			prosePaths(['docs/a.md', 'src/x.ts', 'README.MD', 'docs/a.md', 'notes.txt', 'guide.rst', 'x.adoc', 'y.mdx', 'z.markdown', 'data.json']),
			['docs/a.md', 'README.MD', 'notes.txt', 'guide.rst', 'x.adoc', 'y.mdx', 'z.markdown'],
		);
	});

	test('notify by default; a typo is the default, not off', () => {
		assert.deepStrictEqual([slopGateModeOf(undefined), slopGateModeOf('Enforce'), slopGateModeOf('off'), slopGateModeOf('enforce')], ['notify', 'notify', 'off', 'enforce']);
	});

	test('clean text says nothing; notify reports; enforce sends back until the attempts run out; no bounce where nothing can be sent back', () => {
		const base = { anyFailed: true, attemptsUsed: 0, maxAttempts: 2, canBounce: true };
		assert.deepStrictEqual([
			decideSlopGate({ ...base, mode: 'enforce', anyFailed: false }),
			decideSlopGate({ ...base, mode: 'off' }),
			decideSlopGate({ ...base, mode: 'notify' }),
			decideSlopGate({ ...base, mode: 'enforce' }),
			decideSlopGate({ ...base, mode: 'enforce', attemptsUsed: 2 }),
			decideSlopGate({ ...base, mode: 'enforce', canBounce: false }),
		], ['skip', 'skip', 'report', 'bounce', 'stop', 'report']);
	});
});
