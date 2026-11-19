/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isProtectedAgentConfigPath } from '../../common/agentConfigWriteGuard.js';

/**
 * Инструменты агента не правят его собственную конфигурацию.
 *
 * Каждый тест — набор путей и ожидаемый вердикт: обходы (точки, `..`, регистр, двойные и обратные
 * слэши) обязаны ловиться, а файл с тем же именем вне `.vibe` — оставаться обычным.
 */
suite('agentConfigWriteGuard — защищённые пути конфигурации агента', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const posix = { workspaceRoots: ['/work/proj'], home: '/Users/alice' };
	const windows = { workspaceRoots: ['C:\\work\\proj'], home: 'C:\\Users\\alice' };
	const protectedIn = (options: { workspaceRoots: readonly string[]; home: string | undefined }, path: string) =>
		isProtectedAgentConfigPath(path, options) !== undefined;

	test('файлы и каталоги конфигурации в корне проекта защищены', () => {
		assert.deepStrictEqual({
			hooks: protectedIn(posix, '/work/proj/.vibe/hooks.json'),
			commands: protectedIn(posix, '/work/proj/.vibe/commands.json'),
			agents: protectedIn(posix, '/work/proj/.vibe/agents.json'),
			pipelines: protectedIn(posix, '/work/proj/.vibe/pipelines.json'),
			roles: protectedIn(posix, '/work/proj/.vibe/roles.json'),
			providers: protectedIn(posix, '/work/proj/.vibe/providers.json'),
			mcp: protectedIn(posix, '/work/proj/.vibe/mcp.json'),
			env: protectedIn(posix, '/work/proj/.vibe/.env'),
			skills: protectedIn(posix, '/work/proj/.vibe/skills/review/SKILL.md'),
			rules: protectedIn(posix, '/work/proj/.vibe/rules/style.md'),
			providersFolder: protectedIn(posix, '/work/proj/.vibe/providers/acme.jsonc'),
		}, {
			hooks: true,
			commands: true,
			agents: true,
			pipelines: true,
			roles: true,
			providers: true,
			mcp: true,
			env: true,
			skills: true,
			rules: true,
			providersFolder: true,
		});
	});

	test('то же в домашнем ~/.vibe', () => {
		assert.deepStrictEqual({
			hooks: protectedIn(posix, '/Users/alice/.vibe/hooks.json'),
			mcp: protectedIn(posix, '/Users/alice/.vibe/mcp.json'),
			skills: protectedIn(posix, '/Users/alice/.vibe/skills/x/SKILL.md'),
			providers: protectedIn(posix, '/Users/alice/.vibe/providers/acme.jsonc'),
		}, { hooks: true, mcp: true, skills: true, providers: true });
	});

	test('обходы через `.`, `..`, регистр и двойные слэши ловятся', () => {
		assert.deepStrictEqual({
			точки: protectedIn(posix, '/work/proj/./.vibe/../.vibe/hooks.json'),
			регистр: protectedIn(posix, '/work/proj/.VIBE/HOOKS.JSON'),
			двойные: protectedIn(posix, '/work/proj//.vibe//hooks.json'),
			смешанные: protectedIn(posix, '/work/proj\\.vibe\\hooks.json'),
		}, { точки: true, регистр: true, двойные: true, смешанные: true });
	});

	test('путь Windows с обратными слэшами ловится на любой платформе', () => {
		assert.deepStrictEqual({
			файл: protectedIn(windows, 'C:\\work\\proj\\.vibe\\hooks.json'),
			регистр: protectedIn(windows, 'C:\\WORK\\PROJ\\.VIBE\\HOOKS.JSON'),
			каталог: protectedIn(windows, 'C:\\work\\proj\\.vibe\\skills\\review\\SKILL.md'),
			дом: protectedIn(windows, 'C:\\Users\\alice\\.vibe\\mcp.json'),
		}, { файл: true, регистр: true, каталог: true, дом: true });
	});

	test('относительный путь разворачивается от корня проекта', () => {
		assert.deepStrictEqual({
			защищён: protectedIn(posix, '.vibe/hooks.json'),
			черезТочки: protectedIn(posix, './.vibe/../.vibe/hooks.json'),
			обычный: protectedIn(posix, 'src/hooks.json'),
		}, { защищён: true, черезТочки: true, обычный: false });
	});

	test('файл с тем же именем вне .vibe не защищён', () => {
		assert.deepStrictEqual({
			вИсходниках: protectedIn(posix, '/work/proj/src/hooks.json'),
			суффикс: protectedIn(posix, '/work/proj/.vibe/hooks.json.bak'),
			другойПроект: protectedIn(posix, '/work/other/.vibe/hooks.json'),
			соседПоПрефиксу: protectedIn(posix, '/work/proj2/.vibe/hooks.json'),
			похожееИмя: protectedIn(posix, '/work/proj/.vibe/skills.md'),
		}, { вИсходниках: false, суффикс: false, другойПроект: false, соседПоПрефиксу: false, похожееИмя: false });
	});

	test('хранилище токенов MCP защищено, а одноимённый путь вне его — нет', () => {
		assert.deepStrictEqual({
			поУмолчанию: protectedIn(posix, '/Users/alice/.vibememory/tokens/team/vibeide.json'),
			явныйКорень: isProtectedAgentConfigPath('/var/secure/mcp-tokens/team.json', {
				workspaceRoots: ['/work/proj'],
				home: '/Users/alice',
				tokenStorageRoots: ['/var/secure/mcp-tokens'],
			}) !== undefined,
			внеКорня: protectedIn(posix, '/var/secure/mcp-tokens/team.json'),
		}, { поУмолчанию: true, явныйКорень: true, внеКорня: false });
	});
});
