/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VibeCheckpointCoordinator } from '../../common/vibeCheckpointCoordinatorService.js';

suite('VibeCheckpointCoordinator', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('serializes parallel runExclusive (no overlap)', async () => {
		const c = new VibeCheckpointCoordinator();
		const events: string[] = [];
		const p1 = c.runExclusive({ op: 'a', holderLabel: 'h1' }, async () => {
			events.push('a-start');
			await new Promise<void>(r => setTimeout(r, 15));
			events.push('a-end');
		});
		const p2 = c.runExclusive({ op: 'b', holderLabel: 'h2' }, async () => {
			events.push('b-start');
			events.push('b-end');
		});
		await Promise.all([p1, p2]);
		assert.deepStrictEqual(events, ['a-start', 'a-end', 'b-start', 'b-end']);
	});
});
