/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
// Окружение агента собирает главный процесс; сама сборка чистая, поэтому проверяется здесь
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import { childEnv } from '../../electron-main/acp/vibeAcpMainService.js';

/**
 * Что агент получает из окружения IDE: чужие метки сессии Claude Code ему не достаются
 * Унаследованные, они заставляют агента считать себя запущенным внутри другой своей сессии или голым без входа
 */
suite('acpChildEnv — окружение внешнего агента', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const foreign = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_SIMPLE: '1', KEEP_ME: 'да' };

	test('метки чужой сессии снимаются, включая CLAUDE_CODE_SIMPLE; остальное остаётся', () => {
		const env = childEnv(undefined, foreign);
		assert.deepStrictEqual(
			[env['CLAUDECODE'], env['CLAUDE_CODE_ENTRYPOINT'], env['CLAUDE_CODE_SESSION_ID'], env['CLAUDE_CODE_SIMPLE'], env['KEEP_ME']],
			[undefined, undefined, undefined, undefined, 'да']);
	});

	test('метка, заданная в env записи агента, остаётся: это решение владельца записи', () => {
		const env = childEnv({ CLAUDE_CODE_SIMPLE: '1' }, foreign);
		assert.deepStrictEqual([env['CLAUDE_CODE_SIMPLE'], env['CLAUDECODE']], ['1', undefined]);
	});
});
