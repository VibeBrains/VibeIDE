/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CallFile, resolveCalls } from '../../../common/codeGraph/callResolution.js';
import { analyzeCodeGraph } from '../../../common/codeGraph/codeGraphAnalysis.js';
import { buildCodeGraph } from '../../../common/codeGraph/vibeCodeGraph.js';

/**
 * A call link must say how it was found: through an import it is a lead worth following,
 * By the name alone it is a guess, and a name declared everywhere is no link at all
 */
suite('code graph — calls resolved to files', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ts = (path: string, part: Partial<CallFile>): CallFile => ({ path, languageId: 'typescript', calls: [], imports: [], declared: [], ...part });

	const files: CallFile[] = [
		ts('/p/app.ts', {
			calls: [{ callee: 'save' }, { callee: 'clamp', receiver: 'util' }, { callee: 'render' }, { callee: 'local' }, { callee: 'get', receiver: 'map' }, { callee: 'unique', receiver: 'thing' }, { callee: 'parse' }],
			imports: [{ local: 'save', imported: 'save', specifier: './repo.js' }, { local: 'util', imported: '*', specifier: './util' }],
			declared: ['local'],
		}),
		ts('/p/repo.ts', { declared: ['save', 'get'] }),
		ts('/p/util.ts', { declared: ['clamp', 'get'] }),
		ts('/p/view.ts', { declared: ['render', 'get', 'unique'] }),
		ts('/p/a.ts', { declared: ['parse'] }), ts('/p/b.ts', { declared: ['parse'] }), ts('/p/c.ts', { declared: ['parse'] }), ts('/p/d.ts', { declared: ['parse'] }),
		{ path: '/p/legacy.php', languageId: 'php', calls: [{ callee: 'render' }], imports: [], declared: [] },
	];

	test('imports give leads, unique names give guesses, common names and other languages give nothing', () => {
		assert.deepStrictEqual(
			resolveCalls(files).map(link => `${link.from.slice(3)} -> ${link.to.slice(3)} ${link.provenance}`).sort(),
			[
				'app.ts -> repo.ts inferred',
				'app.ts -> util.ts inferred',
				'app.ts -> view.ts ambiguous',
			],
		);
	});

	test('call links join the graph and count toward subsystems as `calls`', () => {
		const graph = buildCodeGraph(files.map(file => ({ path: file.path })), resolveCalls(files));
		assert.deepStrictEqual(
			analyzeCodeGraph(graph).links.map(link => `${link.kind} ${link.from.slice(3)} -> ${link.to.slice(3)}`).sort(),
			['calls app.ts -> repo.ts', 'calls app.ts -> util.ts', 'calls app.ts -> view.ts'],
		);
	});
});
