/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { DEFAULT_NESTED_RULE_DEPTH, NESTED_RULE_FILE_NAME, collectNestedAgentsUris, isNestedRuleFile, isSkippedRuleDir } from '../../common/nestedRulesScan.js';

suite('nestedRulesScan — вложенные AGENTS.md подпроектов', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('обход не заходит туда, где правил не бывает, а файлов сотни тысяч', () => {
		assert.deepStrictEqual({
			пакеты: ['packages', 'apps', 'services', 'src', 'libs'].map(isSkippedRuleDir),
			// Без пропуска обход правил стал бы обходом всего диска при каждом перечитывании.
			тяжёлые: ['node_modules', 'dist', 'out', 'build', 'target', 'coverage', '.venv'].map(isSkippedRuleDir),
			// Скрытые целиком: там служебное инструментов, а не подпроекты.
			скрытые: ['.git', '.vibe', '.github', '.idea'].map(isSkippedRuleDir),
			пустое: isSkippedRuleDir(''),
			имяФайла: NESTED_RULE_FILE_NAME,
			глубина: DEFAULT_NESTED_RULE_DEPTH,
		}, {
			пакеты: [false, false, false, false, false],
			тяжёлые: [true, true, true, true, true, true, true],
			скрытые: [true, true, true, true],
			пустое: true,
			имяФайла: 'AGENTS.md',
			глубина: 3,
		});
	});

	// On a real file service, not a hand-made tree: a stub that fills in grandchildren hides exactly
	// the defect this walk once had — `resolve` without `resolveTo` expands one level only.
	test('находит правила пакетов на настоящей файловой системе, корневой и спрятанные — нет', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const files = [
			'AGENTS.md',
			'src/AGENTS.md',
			'src/math.js',
			'packages/a/AGENTS.md',
			'packages/b/sub/deep/AGENTS.md',
			'.hidden/AGENTS.md',
			'node_modules/x/AGENTS.md',
		];
		for (const path of files) {
			await fileService.writeFile(URI.file(`/ws/${path}`), VSBuffer.fromString('# rules'));
		}
		const found = async (depth: number) => (await collectNestedAgentsUris(fileService, URI.file('/ws'), depth)).map(uri => uri.path);

		assert.deepStrictEqual({
			поУмолчанию: await found(DEFAULT_NESTED_RULE_DEPTH),
			первыйУровень: await found(1),
			выключено: await found(0),
		}, {
			// Children are walked by name: `packages` before `src`. Level 4 is beyond the default depth.
			поУмолчанию: ['/ws/packages/a/AGENTS.md', '/ws/src/AGENTS.md'],
			первыйУровень: ['/ws/src/AGENTS.md'],
			выключено: [],
		});
	});

	test('изменение вложенного AGENTS.md узнаётся по пути, корневой и спрятанные — нет', () => {
		const root = URI.file('/ws');
		const nested = (path: string) => isNestedRuleFile(root, URI.file(`/ws/${path}`), DEFAULT_NESTED_RULE_DEPTH);
		assert.deepStrictEqual({
			пакет: nested('src/AGENTS.md'),
			глубже: nested('packages/a/AGENTS.md'),
			запределом: nested('a/b/c/d/AGENTS.md'),
			корневой: nested('AGENTS.md'),
			модули: nested('node_modules/x/AGENTS.md'),
			скрытый: nested('.vibe-worktrees/t/src/AGENTS.md'),
			другойФайл: nested('src/README.md'),
			чужойКорень: isNestedRuleFile(root, URI.file('/other/src/AGENTS.md'), DEFAULT_NESTED_RULE_DEPTH),
		}, {
			пакет: true,
			глубже: true,
			запределом: false,
			корневой: false,
			модули: false,
			скрытый: false,
			другойФайл: false,
			чужойКорень: false,
		});
	});
});
