/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { memoryProjectPromptLines, parseProjectResolveAnswer, teamMemoryPromptLines } from '../../common/vibeMemoryProject.js';

/**
 * Имя проекта памяти берётся из ответа сервера, а не угадывается; непонятный ответ — молчание.
 */
suite('vibeMemoryProject — проект памяти открытой папки', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ответы project_resolve: проект, исключённая папка, нет в сторе, мусор', () => {
		assert.deepStrictEqual([
			parseProjectResolveAnswer('{"project": "VibeIDE", "rule": "repo"}'),
			parseProjectResolveAnswer('{"project": null, "why": "the owner excluded this folder (ignoreCwd: ~)"}'),
			parseProjectResolveAnswer('{"project": null, "wouldBe": "tmp"}'),
			parseProjectResolveAnswer('не JSON'),
			parseProjectResolveAnswer('{"project": 42}'),
			parseProjectResolveAnswer('{"project": ""}'),
		], [
			{ project: 'VibeIDE' },
			{ project: null, why: 'the owner excluded this folder (ignoreCwd: ~)' },
			{ project: null, why: 'no project in the store' },
			undefined,
			undefined,
			undefined,
		]);
	});

	test('строки подсказки только для папок с ответом', () => {
		assert.deepStrictEqual([
			memoryProjectPromptLines([
				{ folder: '/work/VibeIDE', answer: { project: 'VibeIDE' } },
				{ folder: '/tmp', answer: { project: null, why: 'no project in the store' } },
				{ folder: '/offline', answer: undefined },
			]),
			memoryProjectPromptLines([{ folder: '/offline', answer: undefined }]),
		], [
			'- /work/VibeIDE: VibeMemory project "VibeIDE" — pass project: "VibeIDE" to memory tools that write.\n- /tmp: no VibeMemory project (no project in the store) — do not write to memory for this folder.',
			undefined,
		]);
	});

	test('память команды: хост не видит диск и называет проекты токена — модель передаёт проект явно', () => {
		const host = parseProjectResolveAnswer(JSON.stringify({ directory: '/Users/me/VibeIDE', project: null, projects: ['VibeIDE', 'VibeIDEA'], why: 'the store is on another machine' }));
		const none = parseProjectResolveAnswer(JSON.stringify({ project: null, projects: [], why: 'no projects' }));
		assert.deepStrictEqual(host, { project: null, why: 'the store is on another machine', projects: ['VibeIDE', 'VibeIDEA'] });
		assert.deepStrictEqual(teamMemoryPromptLines([
			{ serverName: 'vibememory-acme', toolPrefix: 'vibememory-acme_', answer: host! },
			{ serverName: 'vibememory-solo', toolPrefix: 'vibememory-solo_', answer: none! },
		])?.split('\n'), [
			'- vibememory-acme (tools vibememory-acme_*): team memory; it cannot see this disk — pass project explicitly on every write, one of: "VibeIDE", "VibeIDEA".',
			'- vibememory-solo (tools vibememory-solo_*): team memory with no project this token may write to (no projects) — do not write to it.',
		]);
		assert.strictEqual(teamMemoryPromptLines([]), undefined);
	});
});
