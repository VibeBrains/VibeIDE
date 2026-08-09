/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isPurelyAdditive, rangesOverlap, selectCompatibleFixes } from '../../common/quickFixSelection.js';

const at = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) =>
	({ startLineNumber, startColumn, endLineNumber, endColumn });

suite('Quick-fix selection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('overlap: touching endpoints do not count, real intersection does', () => {
		assert.deepStrictEqual(
			{
				touching: rangesOverlap(at(1, 1, 1, 5), at(1, 5, 1, 9)),
				intersecting: rangesOverlap(at(1, 1, 1, 6), at(1, 5, 1, 9)),
				differentLines: rangesOverlap(at(1, 1, 1, 9), at(2, 1, 2, 9)),
				spanning: rangesOverlap(at(1, 1, 3, 1), at(2, 4, 2, 8)),
				// An insertion point inside another edit's range collides with it, boundaries included:
				// "add import" at 1:1 vs "organise imports" rewriting lines 1-2 would duplicate the import.
				insertionAtStart: rangesOverlap(at(1, 1, 1, 1), at(1, 1, 2, 1)),
				insertionOutside: rangesOverlap(at(3, 1, 3, 1), at(1, 1, 2, 1)),
			},
			{ touching: false, intersecting: true, differentLines: false, spanning: true, insertionAtStart: true, insertionOutside: false },
		);
	});

	test('conflicting fixes: the first one wins, the loser is dropped whole', () => {
		const chosen = selectCompatibleFixes([
			{ title: 'add import', edits: [{ range: at(1, 1, 1, 1), text: "import x from 'x';\n" }] },
			{ title: 'organise imports', edits: [{ range: at(1, 1, 2, 1), text: '' }] },
			{ title: 'annotate return', edits: [{ range: at(9, 10, 9, 10), text: ': void' }] },
		]);
		assert.deepStrictEqual(chosen.map(c => c.title), ['add import', 'annotate return']);
	});

	test('a fix conflicting on ANY of its edits is dropped entirely, not partially applied', () => {
		const chosen = selectCompatibleFixes([
			{ title: 'first', edits: [{ range: at(5, 1, 5, 4), text: 'a' }] },
			{ title: 'multi', edits: [{ range: at(1, 1, 1, 2), text: 'b' }, { range: at(5, 2, 5, 3), text: 'c' }] },
		]);
		assert.deepStrictEqual(chosen.map(c => c.title), ['first']);
	});

	// The safety line: "preferred" is the editor's most-likely fix, not a harmless one. TypeScript
	// marks "remove unused declaration" and "change spelling to X" preferred, and both destroy the
	// agent's work — a helper written one step before it is used is legitimately unused, and a call
	// to a not-yet-written function looks exactly like a typo.
	test('only additive fixes may be applied without asking', () => {
		const insertImport = { title: 'add import', edits: [{ range: at(1, 1, 1, 1), text: "import x from 'x';\n" }] };
		const deleteDecl = { title: 'remove unused declaration', edits: [{ range: at(4, 1, 5, 1), text: '' }] };
		const renameCall = { title: "change spelling to 'computeTotal'", edits: [{ range: at(9, 5, 9, 18), text: 'computeTotal' }] };
		const mixed = { title: 'mixed', edits: [{ range: at(1, 1, 1, 1), text: 'a' }, { range: at(3, 1, 3, 4), text: 'b' }] };
		assert.deepStrictEqual(
			[insertImport, deleteDecl, renameCall, mixed].map(isPurelyAdditive),
			[true, false, false, false],
		);
	});

	test('an insertion of empty text is not a fix either', () => {
		assert.strictEqual(isPurelyAdditive({ title: 'noop', edits: [{ range: at(1, 1, 1, 1), text: '' }] }), false);
	});

	test('fixes without edits are skipped', () => {
		assert.deepStrictEqual(selectCompatibleFixes([{ title: 'empty', edits: [] }]), []);
	});
});
