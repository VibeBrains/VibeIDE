/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DEFAULT_NESTED_RULE_DEPTH, NESTED_RULE_FILE_NAME, isSkippedRuleDir } from '../../common/nestedRulesScan.js';

suite('nestedRulesScan — вложенные AGENTS.md подпроектов', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

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
});
