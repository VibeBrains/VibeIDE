/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	CLAUDE_AGENT_SDK_PACKAGE,
	parseInstalledVersion,
	sdkEntryPointPath,
	sdkInstallArgs,
} from '../../common/claudeCode/claudeCodeProvision.js';
import {
	READ_ONLY_TOOLS,
	renderApprovalCard,
	shouldAskOwner,
	toolPermissionOf,
} from '../../common/claudeCode/claudeCodeApproval.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('claudeCode — поставка SDK', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('точка входа проверяется по файлу пакета, а не по папке', () => {
		assert.strictEqual(
			sdkEntryPointPath('/data/claude-agent-sdk'),
			`/data/claude-agent-sdk/node_modules/${CLAUDE_AGENT_SDK_PACKAGE}/package.json`);
	});

	test('версия читается только у нужного пакета', () => {
		assert.deepStrictEqual(
			[
				parseInstalledVersion(`{"name":"${CLAUDE_AGENT_SDK_PACKAGE}","version":"0.3.226"}`),
				parseInstalledVersion('{"name":"other","version":"1.0.0"}'),
				parseInstalledVersion('{ битый json'),
				parseInstalledVersion(`{"name":"${CLAUDE_AGENT_SDK_PACKAGE}"}`),
			],
			['0.3.226', undefined, undefined, undefined]);
	});

	test('установка не пишет манифест в служебную папку и не пинит версию', () => {
		const args = sdkInstallArgs();
		assert.deepStrictEqual(
			[args.includes('--no-save'), args.includes('--no-package-lock'), args.some(a => a.includes('@0.'))],
			[true, true, false]);
	});
});

suite('claudeCode — подтверждения', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const input = { command: 'rm -rf build', description: 'Очистить сборку' };

	test('«Разрешить» возвращает allow и ВСЕГДА отдаёт updatedInput', () => {
		// Без этого поля Claude Code до v2.1.207 отклонял вызов как невалидный.
		assert.deepStrictEqual(toolPermissionOf('approve', input), { behavior: 'allow', updatedInput: input });
	});

	test('«Отклонить» возвращает deny с сообщением', () => {
		const result = toolPermissionOf('reject', input);
		assert.deepStrictEqual([result.behavior, 'message' in result && result.message.length > 0], ['deny', true]);
	});

	test('«Поправить» — это deny с указанием, а не молчаливый отказ', () => {
		const result = toolPermissionOf('amend', input, 'удали только dist, а не всё');
		assert.deepStrictEqual(
			[result.behavior, 'message' in result && result.message.includes('удали только dist, а не всё')],
			['deny', true]);
	});

	test('пустая правка не притворяется указанием', () => {
		const result = toolPermissionOf('amend', input, '   ');
		assert.deepStrictEqual(
			[result.behavior, 'message' in result && result.message.includes('пояснение не дано')],
			['deny', true]);
	});

	suite('карточка для телефона', () => {
		test('Bash показывает команду и пояснение', () => {
			const card = renderApprovalCard('Bash', input);
			assert.deepStrictEqual(
				[card.includes('rm -rf build'), card.includes('Очистить сборку'), card.includes('Bash')],
				[true, true, true]);
		});

		test('Write показывает путь и объём, но не содержимое', () => {
			const card = renderApprovalCard('Write', { file_path: '/app/main.ts', content: 'x'.repeat(5000) });
			assert.deepStrictEqual(
				[card.includes('/app/main.ts'), card.includes('5000'), card.includes('xxxxx')],
				[true, true, false]);
		});

		test('Edit показывает обе стороны замены', () => {
			const card = renderApprovalCard('Edit', { file_path: 'a.ts', old_string: 'было', new_string: 'стало' });
			assert.deepStrictEqual([card.includes('− было'), card.includes('+ стало')], [true, true]);
		});

		test('незнакомый инструмент показывается усечённым JSON, а не теряется', () => {
			const card = renderApprovalCard('SomeNewTool', { alpha: 1, beta: 'два' });
			assert.deepStrictEqual([card.includes('SomeNewTool'), card.includes('alpha'), card.includes('два')], [true, true, true]);
		});

		test('длинная команда обрезается — решение принимается одной рукой', () => {
			const card = renderApprovalCard('Bash', { command: 'echo ' + 'a'.repeat(5000) });
			assert.ok(card.length < 800, `карточка ${card.length} символов — слишком длинная для телефона`);
		});
	});

	suite('что вообще спрашивать', () => {
		test('читающие инструменты по умолчанию на телефон не идут', () => {
			assert.deepStrictEqual(
				READ_ONLY_TOOLS.map(tool => shouldAskOwner(tool, false)),
				READ_ONLY_TOOLS.map(() => false));
		});

		test('пишущие и запускающие спрашиваются всегда', () => {
			assert.deepStrictEqual(
				['Bash', 'Write', 'Edit', 'WebFetch'].map(tool => shouldAskOwner(tool, false)),
				[true, true, true, true]);
		});

		test('владелец может попросить показывать и чтения', () => {
			assert.strictEqual(shouldAskOwner('Read', true), true);
		});
	});
});
