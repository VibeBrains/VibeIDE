/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { composeDiffBlock, receivesRunDiff, RUN_DIFF_DEFAULT_CHARS, runDiffBudgetChars, wantsRunDiff } from '../../common/pipeline/pipelineRunDiff.js';
import { PipelineStepOutcome } from '../../common/pipeline/vibePipelineFile.js';

suite('pipelineRunDiff', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const done: PipelineStepOutcome = { role: 'backend-dev', step: 1, status: 'success', summary: 'сделал', artifacts: ['src/a.ts'] };
	const section = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`;

	test('judges get the diff once something ran; fresh eyes and makers do not', () => {
		assert.deepStrictEqual({
			critic: receivesRunDiff({ role: 'critic' }, [done]),
			criticFirst: receivesRunDiff({ role: 'critic' }, []),
			freshEyes: receivesRunDiff({ role: 'code-reviewer', ignorePreviousArtifacts: true }, [done]),
			maker: receivesRunDiff({ role: 'backend-dev' }, [done]),
			orchestrator: wantsRunDiff({ role: 'orchestrator' }),
			judges: ['explore', 'planner', 'code-reviewer', 'security', 'critic'].map(role => wantsRunDiff({ role })),
		}, {
			critic: true,
			criticFirst: false,
			freshEyes: false,
			maker: false,
			orchestrator: false,
			judges: [true, true, true, true, true],
		});
	});

	test('the budget is half the step ceiling at four characters a token, 40 000 without one', () => {
		assert.deepStrictEqual([runDiffBudgetChars(undefined), runDiffBudgetChars(0), runDiffBudgetChars(10_000), runDiffBudgetChars(10_001)], [RUN_DIFF_DEFAULT_CHARS, RUN_DIFF_DEFAULT_CHARS, 20_000, 20_000]);
	});

	test('whole files first, then a mark that says how much is missing and where to look', () => {
		const a = section('src/a.ts', '-old\n+new');
		const b = section('src/b.ts', '-x\n+y');
		const block = composeDiffBlock('run', { sections: [a, b], files: 3, hidden: 1 }, a.length + 5);
		assert.strictEqual(block, [
			'Дифф прогона — что изменилось в проекте с начала пайплайна, новые и удалённые файлы тоже:',
			'```diff',
			a.trimEnd(),
			'```',
			'Дифф обрезан по объёму: показано файлов 1 из 3 — остальное прочитайте по путям сами.',
			'Файлов, закрытых для агента правилами чтения, в диффе нет: 1.',
		].join('\n'));
	});

	test('a first file larger than the budget is shown from its start, cut at a line', () => {
		const big = section('src/big.ts', Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n'));
		const block = composeDiffBlock('step', { sections: [big], files: 1, hidden: 0 }, 80);
		const shown = block.split('```diff\n')[1].split('\n```')[0];
		assert.deepStrictEqual({
			title: block.startsWith('Дифф шага — что изменил проверяемый шаг:'),
			withinBudget: shown.length <= 80,
			endsAtLine: big.startsWith(`${shown}\n`),
			marked: block.endsWith('Дифф обрезан по объёму: показано файлов 1 из 1, и первый не целиком — остальное прочитайте по путям сами.'),
		}, { title: true, withinBudget: true, endsAtLine: true, marked: true });
	});

	test('nothing to show says why, and a diff of Markdown cannot close its own fence', () => {
		const markdown = section('README.md', '+```ts\n+code\n+```');
		assert.deepStrictEqual({
			unavailable: composeDiffBlock('run', { sections: [], files: 0, hidden: 0, unavailable: 'папка не под git' }, 100),
			onlyHidden: composeDiffBlock('step', { sections: [], files: 0, hidden: 2 }, 100),
			nothing: composeDiffBlock('run', { sections: [], files: 0, hidden: 0 }, 100),
			fence: composeDiffBlock('run', { sections: [markdown], files: 1, hidden: 0 }, 1000).split('\n')[1],
		}, {
			unavailable: 'Дифф прогона — что изменилось в проекте с начала пайплайна, новые и удалённые файлы тоже: недоступен — папка не под git.',
			onlyHidden: 'Дифф шага — что изменил проверяемый шаг: изменения есть только в файлах, закрытых для агента правилами чтения (2).',
			nothing: 'Дифф прогона — что изменилось в проекте с начала пайплайна, новые и удалённые файлы тоже: изменений нет.',
			fence: '````diff',
		});
	});
});
