/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildCommandInvocationBlock, buildCommitRequest, buildWorkflowExpansion } from '../../common/vibeSlashCommandService.js';
import { renderPromptVariables } from '../../common/vibePromptLibraryService.js';
import { parseWorkflowFile } from '../../common/vibeWorkflowService.js';

suite('Slash commands — what reaches the model', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('renderPromptVariables: $ARGS as a whole word only, the value inserted literally, unknown names left visible', () => {
		assert.deepStrictEqual([
			renderPromptVariables('Ревью $ARGS, не трогая $ARGUMENTS и $ARGS_X', { ARGS: 'auth' }),
			renderPromptVariables('run $ARGS', { ARGS: 'echo $& $1 $$' }),
			renderPromptVariables('Проверь с точки зрения $ASPECT: $ARGS', { ARGS: '' }),
		], [
			'Ревью auth, не трогая $ARGUMENTS и $ARGS_X',
			'run echo $& $1 $$',
			'Проверь с точки зрения $ASPECT: ',
		]);
	});

	test('parseWorkflowFile: the id is the file name; the title and step fields come from the file', () => {
		const text = JSON.stringify({
			vibeVersion: '1.0.0',
			name: 'Выпуск',
			description: 'От ветки до тега',
			steps: [
				{ name: 'Проверки', description: 'Гейты и тесты' },
				{ name: 'Тег', prompt: 'Поставь тег vX.Y.Z', requiresApproval: true },
			],
		});
		assert.deepStrictEqual(parseWorkflowFile(text, 'release'), {
			workflow: {
				id: 'release',
				name: 'Выпуск',
				description: 'От ветки до тега',
				steps: [
					{ name: 'Проверки', description: 'Гейты и тесты' },
					{ name: 'Тег', description: '', prompt: 'Поставь тег vX.Y.Z', requiresApproval: true },
				],
			},
		});
	});

	test('parseWorkflowFile: without a title the id stands in; what is not a workflow says so', () => {
		const untitled = parseWorkflowFile('{"steps": [{"name": "a"}]}', 'example');
		const broken = ['{', '[]', '{"steps": []}', '{"steps": [{}]}', '{"steps": [{"name": "a", "requiresApproval": "да"}]}', '{"name": 1, "steps": [{"name": "a"}]}'];
		assert.deepStrictEqual({
			title: 'workflow' in untitled ? untitled.workflow.name : undefined,
			broken: broken.map(text => 'error' in parseWorkflowFile(text, 'x')),
		}, { title: 'example', broken: broken.map(() => true) });
	});

	test('buildWorkflowExpansion: every step, its instructions and the approval stop reach the model', () => {
		assert.strictEqual(buildWorkflowExpansion({
			id: 'release',
			name: 'Выпуск',
			description: 'От ветки до тега',
			steps: [
				{ name: 'Проверки', description: 'Гейты и тесты' },
				{ name: 'Тег', description: '', prompt: 'Поставь тег', requiresApproval: true },
			],
		}), [
			'Execute workflow "Выпуск": От ветки до тега',
			'',
			'Steps:',
			'1. Проверки: Гейты и тесты',
			'2. Тег',
			'   Instructions: Поставь тег',
			'   Before starting this step, stop and ask the user for approval.',
			'',
			'Work through the steps in order.',
		].join('\n'));
	});

	test('buildCommitRequest: commits what is staged and never stages by itself; pushes only with --push', () => {
		const plain = buildCommitRequest('');
		const pushed = buildCommitRequest('--push про авторизацию');
		assert.deepStrictEqual({
			stopsOnEmptyStage: plain.includes('If nothing is staged, say so and stop'),
			plainPushes: plain.includes('git push'),
			pushedPushes: pushed.includes('then run `git push`'),
			note: pushed.split('\n').pop(),
		}, {
			stopsOnEmptyStage: true,
			plainPushes: false,
			pushedPushes: true,
			note: 'The user\'s note about this commit: про авторизацию',
		});
	});

	test('buildCommandInvocationBlock: an expansion goes in a named block; a missing file is reported, not guessed', () => {
		assert.deepStrictEqual([
			buildCommandInvocationBlock('simplify', 'Review the diff'),
			buildCommandInvocationBlock('my:review', null),
			buildCommandInvocationBlock('workflow:release', null),
		], [
			'The user invoked /simplify. The block below is the request itself; text after the command in the user\'s message adds to it.\n\n<command_invocation name="simplify">\nReview the diff\n</command_invocation>',
			'The user typed /my:review, but .vibe/prompts/review.md does not exist in this project. Say so in one sentence, then answer the rest of the message, if there is any.',
			'The user typed /workflow:release, but .vibe/workflows/release.json does not exist in this project. Say so in one sentence, then answer the rest of the message, if there is any.',
		]);
	});
});
