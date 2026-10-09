/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LAYOUT_SETTLED_ENERGY, seedPositions, stepLayout } from '../../common/vibeDocsGraphLayout.js';

/**
 * A hub pulled by hundreds of springs once flung the picture off the screen and never settled
 * The project graph has such hubs on every subsystem view: a neighbouring subsystem linked by every file
 */
suite('graph layout — dense hubs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function runStar(hubDegree: number) {
		const leaves = Array.from({ length: 300 }, (_, i) => `leaf${i}`);
		const edges = leaves.map(leaf => ({ from: leaf, to: 'hub' }));
		const degrees = new Map<string, number>([['hub', hubDegree], ...leaves.map(leaf => [leaf, 1] as [string, number])]);
		const nodes = seedPositions(['hub', ...leaves], degrees);
		let energy = Infinity;
		for (let tick = 0; tick < 3000 && energy >= LAYOUT_SETTLED_ENERGY; tick++) {
			energy = stepLayout(nodes, edges);
		}
		const extent = Math.max(...nodes.map(node => Math.max(Math.abs(node.x), Math.abs(node.y))));
		return { finite: nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)), settled: energy < LAYOUT_SETTLED_ENERGY, onScreen: extent < 3000 };
	}

	test('a hub weighed by its links settles; a hub given the wrong weight still stays on screen', () => {
		assert.deepStrictEqual(
			{ weighedByLinks: runStar(300), wrongWeight: { ...runStar(1), settled: 'any' } },
			{ weighedByLinks: { finite: true, settled: true, onScreen: true }, wrongWeight: { finite: true, settled: 'any', onScreen: true } },
		);
	});
});
