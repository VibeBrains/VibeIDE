/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decideSkillLaunch } from '../../common/skillApproval.js';
import { parseSkillMarkdown } from '../../common/vibeSkillsLibraryService.js';

/**
 * Навык, просящий инструменты или хуки, без человека не запускается молча.
 *
 * Одобрение пакета отвечает «кто видел эти байты», а решение о запуске — «можно ли исполнять их
 * без человека». Второе и проверяется здесь, включая разбор самой шапки навыка.
 */
suite('decideSkillLaunch — навык с инструментами или хуками без человека', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const facts = (overrides: Partial<Parameters<typeof decideSkillLaunch>[0]>) => decideSkillLaunch({
		declaresTools: false,
		declaresHooks: false,
		interactive: true,
		digest: 'digest-1',
		approvedDigest: undefined,
		...overrides,
	});

	test('навык без инструментов и хуков разрешён в любом режиме', () => {
		assert.deepStrictEqual({
			интерактивный: facts({ interactive: true }).decision,
			автономный: facts({ interactive: false }).decision,
		}, { интерактивный: 'allow', автономный: 'allow' });
	});

	test('интерактивный запуск неодобренного навыка с инструментами — спросить', () => {
		assert.deepStrictEqual(facts({ declaresTools: true, interactive: true }).decision, 'ask');
	});

	test('одобренный именно этот отпечаток разрешает автономный запуск', () => {
		assert.deepStrictEqual({
			инструменты: facts({ declaresTools: true, interactive: false, approvedDigest: 'digest-1' }).decision,
			хуки: facts({ declaresHooks: true, interactive: false, approvedDigest: 'digest-1' }).decision,
		}, { инструменты: 'allow', хуки: 'allow' });
	});

	test('автономный запуск неодобренного навыка с инструментами отклоняется с причиной', () => {
		const verdict = facts({ declaresTools: true, interactive: false });
		assert.deepStrictEqual({
			решение: verdict.decision,
			естьПричина: typeof verdict.reason === 'string' && verdict.reason.includes('одобрите его в IDE'),
		}, { решение: 'reject', естьПричина: true });
	});

	test('другой отпечаток или его отсутствие — не одобрение', () => {
		assert.deepStrictEqual({
			другой: facts({ declaresTools: true, interactive: false, approvedDigest: 'digest-2' }).decision,
			безОтпечатка: facts({ declaresTools: true, interactive: false, digest: undefined }).decision,
		}, { другой: 'reject', безОтпечатка: 'reject' });
	});

	test('объявление хуков в шапке читается разбором навыка', () => {
		const parsed = parseSkillMarkdown(`---
name: hook-demo
description: Навык объявляет хуки.
hooks:
  pre: scripts/pre.sh
---

Тело.
`, '.vibe/skills/hook-demo/SKILL.md', 'hook-demo');
		assert.deepStrictEqual(parsed?.hooks, true);
	});
});
