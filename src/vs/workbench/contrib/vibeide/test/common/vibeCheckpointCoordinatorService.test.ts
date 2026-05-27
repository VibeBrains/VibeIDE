/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { VibeCheckpointCoordinator } from '../../common/vibeCheckpointCoordinatorService.js';

suite('VibeCheckpointCoordinator', () => {
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
