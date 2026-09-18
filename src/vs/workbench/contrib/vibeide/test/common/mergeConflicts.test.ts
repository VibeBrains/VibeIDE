/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeConflictsForAgent, hasMergeConflicts, parseMergeConflicts } from '../../common/vibeMergeConflictService.js';

const conflicted = [
	'const a = 1;',
	'<<<<<<< HEAD',
	'const b = 2;',
	'=======',
	'const b = 3;',
	'const c = 4;',
	'>>>>>>> feature/x',
	'const d = 5;',
].join('\n');

suite('mergeConflicts — разбор фактов, решение за агентом', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('блок разбирается: строка, подписи сторон, их содержимое', () => {
		assert.deepStrictEqual(parseMergeConflicts('src/a.ts', conflicted), {
			filePath: 'src/a.ts',
			malformed: false,
			blocks: [{
				startLine: 2,
				ourLabel: 'HEAD',
				theirLabel: 'feature/x',
				ourLines: ['const b = 2;'],
				theirLines: ['const b = 3;', 'const c = 4;'],
				closed: true,
			}],
		});
	});

	/** Незакрытый маркер — файл правили руками: об этом говорят, а не делают вид, что всё обычно. */
	test('незакрытый блок помечается, файл без маркеров даёт пустой отчёт', () => {
		const broken = parseMergeConflicts('src/b.ts', '<<<<<<< HEAD\nодна сторона\n');
		assert.deepStrictEqual(
			[broken.malformed, broken.blocks[0].closed, parseMergeConflicts('src/c.ts', 'чисто').blocks.length, hasMergeConflicts('чисто')],
			[true, false, 0, false],
		);
	});

	test('задание агенту называет места и запрещает выбор стороны не читая', () => {
		const task = describeConflictsForAgent([parseMergeConflicts('src/a.ts', conflicted)]);
		assert.deepStrictEqual(
			[task.includes('src/a.ts: 1 конфликт(ов)'), task.includes('строка 2 (HEAD ↔ feature/x)'), task.includes('стирать чужую не читая — нельзя')],
			[true, true, true],
		);
	});
});
