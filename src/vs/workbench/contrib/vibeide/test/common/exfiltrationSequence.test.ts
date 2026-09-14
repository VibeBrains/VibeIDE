/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ToolTrailView } from '../../common/hooks/toolCallTrail.js';
import {
	describeExfiltrationFinding,
	findExfiltrationSequences,
	DEFAULT_EXFILTRATION_WINDOW_SECONDS,
} from '../../common/hooks/exfiltrationSequence.js';

suite('последовательность «секрет → сеть»', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** `secondsAgo` считается от «сейчас», поэтому у более позднего вызова значение МЕНЬШЕ. */
	const call = (tool: string, secondsAgo: number, over: Partial<ToolTrailView> = {}): ToolTrailView =>
		({ tool, secondsAgo, ...over });

	test('чтение секрета, затем сетевой вызов — находка с интервалом', () => {
		const trail = [
			call('read_file', 90, { path: '.env' }),
			call('browse_url', 60),
		];
		assert.deepStrictEqual(findExfiltrationSequences(trail), [
			{ secretPath: '.env', networkTool: 'browse_url', gapSeconds: 30 },
		]);
	});

	/**
	 * Порядок — по времени, а не по позиции в массиве.
	 *
	 * Вызывающий может подрезать след, и правило, молча зависящее от порядка элементов, сломается
	 * тихо. Здесь сетевой вызов стоит в массиве ПЕРВЫМ, а по времени — вторым.
	 */
	test('решает время, а не позиция в массиве', () => {
		const trail = [
			call('browse_url', 10),
			call('read_file', 40, { path: 'config/.env.local' }),
		];
		assert.strictEqual(findExfiltrationSequences(trail).length, 1);
	});

	test('обратный порядок — не находка', () => {
		const trail = [
			call('browse_url', 90),
			call('read_file', 60, { path: '.env' }),
		];
		assert.deepStrictEqual(findExfiltrationSequences(trail), []);
	});

	/**
	 * Одновременность не есть последовательность: при секундном разрешении это один момент, и
	 * назвать его «сначала прочитал, потом отправил» — утверждение, которого данные не дают.
	 */
	test('совпавшие метки времени не считаются парой', () => {
		const trail = [call('read_file', 30, { path: '.env' }), call('browse_url', 30)];
		assert.deepStrictEqual(findExfiltrationSequences(trail), []);
	});

	test('за пределами окна — не находка', () => {
		const trail = [
			call('read_file', DEFAULT_EXFILTRATION_WINDOW_SECONDS + 61, { path: '.env' }),
			call('browse_url', 60),
		];
		assert.deepStrictEqual(findExfiltrationSequences(trail), []);
	});

	/** Вызов MCP уводит аргументы на чужой сервер, как бы инструмент ни назывался. */
	test('любой вызов MCP считается сетевым', () => {
		const trail = [
			call('read_file', 50, { path: '~/.aws/credentials' }),
			call('lookup_customer', 20, { server: 'crm' }),
		];
		assert.deepStrictEqual(findExfiltrationSequences(trail), [
			{ secretPath: '~/.aws/credentials', networkTool: 'lookup_customer', server: 'crm', gapSeconds: 30 },
		]);
	});

	test('обычный файл секретом не считается', () => {
		const trail = [call('read_file', 50, { path: 'src/environment.ts' }), call('browse_url', 20)];
		assert.deepStrictEqual(findExfiltrationSequences(trail), []);
	});

	/** Папки конфигов агентов — то, что в отчёте GTIG выгребали наравне с `.env`. */
	test('узнаются пути, названные в отчёте, и классика рядом с ними', () => {
		const paths = ['.env', '.claude/settings.json', '.vscode/mcp.json', '.cursor/mcp.json',
			'.ssh/id_rsa', 'deploy.pem', 'secrets/token.txt', '.npmrc'];
		const found = paths.filter(path =>
			findExfiltrationSequences([call('read_file', 50, { path }), call('browse_url', 20)]).length === 1);
		assert.deepStrictEqual(found, paths);
	});

	test('строка для журнала называет обе стороны и интервал', () => {
		assert.strictEqual(
			describeExfiltrationFinding({ secretPath: '.env', networkTool: 'browse_url', gapSeconds: 12 }),
			'прочитан «.env», через 12 с — сетевой вызов browse_url');
		assert.strictEqual(
			describeExfiltrationFinding({ secretPath: '.env', networkTool: 'send', server: 'crm', gapSeconds: 5 }),
			'прочитан «.env», через 5 с — сетевой вызов send (сервер crm)');
	});
});
