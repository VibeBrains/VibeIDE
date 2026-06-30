/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildNextEditGhostText,
	scoreJumpCandidate,
	pickBestJumpCandidate,
	JumpCandidate,
} from '../../common/nextEditGhostText.js';

const cand = (overrides: Partial<JumpCandidate>): JumpCandidate => ({
	uri: 'file:///a.ts',
	line: 1,
	matchText: 'foo',
	...overrides,
});

suite('Next-edit ghost-text builder (1029)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildNextEditGhostText', () => {
		test('rename theme + matching candidate → ghost = replacement', () => {
			const r = buildNextEditGhostText(
				{ kind: 'rename', subject: 'foo', subjectReplacement: 'bar' },
				cand({}),
			);
			assert.strictEqual(r.ghostText, 'bar');
			assert.match(r.hintLabel, /Next rename/);
		});

		test('rename theme but candidate matchText differs → empty ghost', () => {
			const r = buildNextEditGhostText(
				{ kind: 'rename', subject: 'foo', subjectReplacement: 'bar' },
				cand({ matchText: 'other' }),
			);
			assert.strictEqual(r.ghostText, '');
		});

		test('rename theme without replacement → empty', () => {
			const r = buildNextEditGhostText(
				{ kind: 'rename', subject: 'foo' },
				cand({}),
			);
			assert.strictEqual(r.ghostText, '');
		});

		test('signature-change → empty ghost, but hint label set', () => {
			const r = buildNextEditGhostText(
				{ kind: 'signature-change', subject: 'doSomething' },
				cand({ matchText: 'doSomething' }),
			);
			assert.strictEqual(r.ghostText, '');
			assert.match(r.hintLabel, /Next call site/);
		});
	});

	suite('scoreJumpCandidate', () => {
		test('uri in recentlyTouched → score = index', () => {
			const recent = ['file:///a.ts', 'file:///b.ts'];
			assert.strictEqual(scoreJumpCandidate(cand({ uri: 'file:///a.ts' }), recent), 0);
			assert.strictEqual(scoreJumpCandidate(cand({ uri: 'file:///b.ts' }), recent), 1);
		});

		test('not-recent uri → score = recent.length + line', () => {
			const recent = ['file:///a.ts'];
			assert.strictEqual(scoreJumpCandidate(cand({ uri: 'file:///c.ts', line: 50 }), recent), 51);
		});

		test('excluded uri → Infinity', () => {
			const ex = new Set(['file:///excluded.ts']);
			assert.strictEqual(scoreJumpCandidate(cand({ uri: 'file:///excluded.ts' }), [], ex), Infinity);
		});
	});

	suite('pickBestJumpCandidate', () => {
		test('empty list → undefined', () => {
			assert.strictEqual(pickBestJumpCandidate([], []), undefined);
		});

		test('all excluded → undefined', () => {
			const ex = new Set(['file:///x.ts']);
			assert.strictEqual(pickBestJumpCandidate([cand({ uri: 'file:///x.ts' })], [], ex), undefined);
		});

		test('picks lowest-score candidate', () => {
			const recent = ['file:///b.ts', 'file:///a.ts'];
			const r = pickBestJumpCandidate(
				[cand({ uri: 'file:///a.ts', line: 5 }), cand({ uri: 'file:///b.ts', line: 5 })],
				recent,
			);
			assert.strictEqual(r?.uri, 'file:///b.ts');
		});

		test('candidate not in recent ranks below candidate that is', () => {
			const recent = ['file:///a.ts'];
			const r = pickBestJumpCandidate(
				[
					cand({ uri: 'file:///b.ts', line: 50 }),
					cand({ uri: 'file:///a.ts', line: 200 }),
				],
				recent,
			);
			assert.strictEqual(r?.uri, 'file:///a.ts');
		});
	});
});
