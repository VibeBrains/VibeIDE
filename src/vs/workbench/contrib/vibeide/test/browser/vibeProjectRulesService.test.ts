/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { VibeProjectRulesService } from '../../browser/vibeProjectRulesService.js';
import { IVibePromptGuardService, PromptGuardResult } from '../../common/vibePromptGuardService.js';

/** The sanitizer is not under test: what reaches the agent's rules is. */
class PassThroughPromptGuard extends mock<IVibePromptGuardService>() {
	override sanitizeFileContent(content: string): PromptGuardResult {
		return { isSafe: true, warnings: [], sanitized: content };
	}
}

suite('VibeProjectRulesService — правило пакета доходит до хода агента', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	// End to end over the real walk and the real `resolve`: the defect this guards against sat between
	// the two — every piece was fine in isolation and the rule of a package never reached the agent.
	test('вложенный AGENTS.md вставлен с меткой источника, условное правило — только в списке доступных', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const write = (path: string, text: string) => fileService.writeFile(URI.file(`/ws/${path}`), VSBuffer.fromString(text));
		await write('src/AGENTS.md', '# Правила пакета src\n\nКаждая новая функция начинается с комментария `// ЛИМОН`.\n');
		await write('.vibe/rules/review.mdc', '---\ndescription: Ревью\nalwaysApply: false\n---\nПроверяй тесты.\n');
		await write('src/math.js', 'export const add = (a, b) => a + b;\n');

		const service = disposables.add(new VibeProjectRulesService(
			new NullLogService(),
			fileService,
			new TestContextService(testWorkspace(URI.file('/ws'))),
			new PassThroughPromptGuard(),
			new TestConfigurationService(),
		));
		await service.reloadRules();
		const combined = service.getCombinedRules({ userText: 'Добавь в src/math.js функцию cube' });

		assert.deepStrictEqual({
			источники: service.getLoadedSources().map(source => source.relativePath).sort(),
			метка: combined.includes('[Source: src/AGENTS.md]'),
			текст: combined.includes('// ЛИМОН'),
			условноеНеВставлено: combined.includes('Проверяй тесты.'),
			условноеВСписке: combined.includes('[Available project rules'),
		}, {
			источники: ['.vibe/rules/review.mdc', 'src/AGENTS.md'],
			метка: true,
			текст: true,
			условноеНеВставлено: false,
			условноеВСписке: true,
		});
	});

	// The watcher used to fire an event nobody listened to: the log said «cache invalidated», and the
	// agent kept the old rules until a restart. The change has to reach the next turn by itself.
	test('правило пакета, созданное после загрузки, попадает в правила следующего хода', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const write = (path: string, text: string) => fileService.writeFile(URI.file(`/ws/${path}`), VSBuffer.fromString(text));
		await write('src/AGENTS.md', '# Правила пакета src\n\nКаждая новая функция начинается с комментария `// ЛИМОН`.\n');

		const service = disposables.add(new VibeProjectRulesService(
			new NullLogService(),
			fileService,
			new TestContextService(testWorkspace(URI.file('/ws'))),
			new PassThroughPromptGuard(),
			new TestConfigurationService(),
		));
		await service.reloadRules();

		const reloaded = Event.toPromise(service.onRulesChanged);
		await write('packages/web/AGENTS.md', '# Правила пакета web\n\nКаждый новый компонент начинается с комментария `// ГРУША`.\n');
		await reloaded;
		const combined = service.getCombinedRules({ userText: 'Добавь компонент' });

		assert.deepStrictEqual({
			источники: service.getLoadedSources().map(source => source.relativePath).sort(),
			метка: combined.includes('[Source: packages/web/AGENTS.md]'),
			текст: combined.includes('// ГРУША'),
		}, {
			источники: ['packages/web/AGENTS.md', 'src/AGENTS.md'],
			метка: true,
			текст: true,
		});
	});

	// The system prompt is the cached prefix: a rule switched on by this request must not change it, it rides with the message
	test('правила хода: постоянные и список условных — в системный промпт, сработавшие условные — к сообщению', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const write = (path: string, text: string) => fileService.writeFile(URI.file(`/ws/${path}`), VSBuffer.fromString(text));
		await write('.vibe/rules.md', '# Правила\n\nОтвечай по-русски.\n');
		await write('.vibe/rules/deploy.mdc', '---\ndescription: Выкладка\ntriggers: "деплой"\n---\nПеред деплоем — `// ЛИМОН` в журнал.\n');
		await write('.vibe/rules/review.mdc', '---\ndescription: Ревью\nalwaysApply: false\n---\nПроверяй тесты.\n');

		const service = disposables.add(new VibeProjectRulesService(
			new NullLogService(),
			fileService,
			new TestContextService(testWorkspace(URI.file('/ws'))),
			new PassThroughPromptGuard(),
			new TestConfigurationService(),
		));
		await service.reloadRules();
		const touchingSrc = service.getRulesForTurn({ userText: 'Сделай деплой на стенд' });
		const elsewhere = service.getRulesForTurn({ userText: 'Поправь README' });

		assert.deepStrictEqual({
			постоянныеОдинаковы: touchingSrc.standing === elsewhere.standing,
			постоянноеВнутри: touchingSrc.standing.includes('Отвечай по-русски.'),
			условныеВСписке: touchingSrc.standing.includes('[Conditional project rules') && touchingSrc.standing.includes('review'),
			телоУсловногоНеВСистемном: touchingSrc.standing.includes('// ЛИМОН'),
			сработавшееКСообщению: touchingSrc.activated.includes('[Source: .vibe/rules/deploy.mdc]') && touchingSrc.activated.includes('// ЛИМОН'),
			несработавшегоНет: elsewhere.activated,
		}, {
			постоянныеОдинаковы: true,
			постоянноеВнутри: true,
			условныеВСписке: true,
			телоУсловногоНеВСистемном: false,
			сработавшееКСообщению: true,
			несработавшегоНет: '',
		});
	});
});
