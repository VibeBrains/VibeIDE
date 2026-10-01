/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	DEFAULT_WORKTREE_INCLUDE_FILES, folderExcludeLine, linkExcludeLine, parseNulList, readPatternList, readWorktreeLinkMode,
	selectIncludeFiles, selectLinkFolders, WORKTREE_INCLUDE_ARGV,
} from '../../common/worktreeIncludePolicy.js';

suite('worktreeIncludePolicy — игнорируемое git в дереве роли', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('папки: имя на любой глубине, путь-шаблон от корня, вложенная уходит под объемлющую', () => {
		const entries = [
			'node_modules/',
			'packages/app/node_modules/',
			'packages/app/node_modules/inner/node_modules/',
			'out/',
			'.env',
			// Деревья агентов сами игнорируются — и копии зависимостей в них брать нельзя
			'.vibe-worktrees/',
			'.vibe-worktrees/other/node_modules/',
		];
		assert.deepStrictEqual({
			поИмени: selectLinkFolders(entries, ['node_modules'], []),
			поПути: selectLinkFolders(entries, ['packages/*/node_modules'], []),
			безШаблонов: selectLinkFolders(entries, [], []),
			// Сборочные папки приносятся только по явной просьбе
			сборкаПоПросьбе: selectLinkFolders(entries, ['out'], []),
		}, {
			поИмени: ['node_modules', 'packages/app/node_modules'],
			поПути: ['packages/app/node_modules'],
			безШаблонов: [],
			сборкаПоПросьбе: ['out'],
		});
	});

	test('папки: отслеживаемое в дереве не накрывается ни ссылкой, ни копией', () => {
		const entries = ['node_modules/', 'vendor/node_modules/', 'lib/node_modules/'];
		assert.deepStrictEqual(selectLinkFolders(entries, ['node_modules'], [
			// Отслеживаемый файл внутри — папка не целиком наша
			'vendor/node_modules/patched.js',
			// Отслеживаемый файл на месте одной из папок пути
			'lib',
		]), ['node_modules']);
	});

	test('файлы: glob редактора решает окончательно, принесённые папки и деревья агентов пропускаются', () => {
		const ignored = [
			'.env',
			'.env.production',
			'apps/web/.env.local',
			'.env.local',
			'apps/web/.env',
			'node_modules/pkg/.env.local',
			'.vibe-worktrees/vibe-agent-1/.env',
			'secrets.json',
		];
		assert.deepStrictEqual({
			поУмолчанию: selectIncludeFiles(ignored, DEFAULT_WORKTREE_INCLUDE_FILES, [], ['node_modules']),
			пустойСписок: selectIncludeFiles(ignored, [], [], []),
			// Отслеживаемый в дереве путь — работа, а не окружение: копия поверх стёрла бы её
			занятОтслеживаемым: selectIncludeFiles(['.env', 'cfg/.env.local'], ['.env', '**/.env.local'], ['.env', 'cfg'], []),
		}, {
			поУмолчанию: ['.env', '.env.local', '.env.production', 'apps/web/.env.local'],
			пустойСписок: [],
			занятОтслеживаемым: [],
		});
	});

	test('настройки: чужие значения не превращаются в «ничего не приносить»', () => {
		assert.deepStrictEqual({
			режимMac: readWorktreeLinkMode(undefined, true),
			режимДругие: readWorktreeLinkMode('чушь', false),
			режимЯвный: readWorktreeLinkMode('none', true),
			списокНеСписок: readPatternList('node_modules', ['x']),
			списокСМусором: readPatternList([' .env ', '', 42, null], []),
			пустойСписокЯвный: readPatternList([], ['x']),
		}, {
			режимMac: 'clone',
			режимДругие: 'link',
			режимЯвный: 'none',
			списокНеСписок: ['x'],
			списокСМусором: ['.env'],
			пустойСписокЯвный: [],
		});
	});

	test('строки info/exclude: ссылка без слэша — иначе git видит её файлом и коммитит', () => {
		assert.deepStrictEqual({
			папкаДерева: folderExcludeLine('.vibe-worktrees/vibe-agent-1'),
			ссылка: linkExcludeLine('node_modules'),
			вложеннаяСсылка: linkExcludeLine('packages\\app\\node_modules\\'),
		}, {
			папкаДерева: '/.vibe-worktrees/vibe-agent-1/',
			ссылка: '/node_modules',
			вложеннаяСсылка: '/packages/app/node_modules',
		});
	});

	test('argv: шаблоны идут pathspec-ами, деревья агентов и принесённые папки исключены', () => {
		assert.deepStrictEqual({
			файлы: WORKTREE_INCLUDE_ARGV.ignoredFiles(['.env', '**/.env.local'], ['node_modules']),
			снятьСИндекса: WORKTREE_INCLUDE_ARGV.unstage(['node_modules', 'a b/node_modules']),
			разборNul: parseNulList('.env\0node_modules/\0\0'),
		}, {
			файлы: ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ':(glob).env', ':(glob)**/.env.local', ':(exclude,literal).vibe-worktrees', ':(exclude,literal)node_modules'],
			снятьСИндекса: ['--literal-pathspecs', 'rm', '--cached', '--ignore-unmatch', '-q', '--', 'node_modules', 'a b/node_modules'],
			разборNul: ['.env', 'node_modules/'],
		});
	});
});
