/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { IWebWorkerClient } from '../../../../../base/common/worker/webWorker.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWebWorkerService } from '../../../../../platform/webWorker/browser/webWorkerService.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { VibeTextSlopService } from '../../browser/vibeTextSlopService.js';
import { TextSlopWorker } from '../../common/textSlop/textSlopWorker.js';

/**
 * Сервис — одна точка для всех поверхностей (инструмент, правило текста страницы, хук дизайна): каталог сборки плюс
 * `.vibe/slop.json` проекта. Проверяется на настоящем FileService поверх файловой системы в памяти; воркер подставной —
 * тот же `TextSlopWorker`, только в этом потоке. Что сторож делает с зависшим правилом — `test/common/slopWatchdog.test.ts`
 */
suite('VibeTextSlopService — каталог сборки с правками проекта', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const inThreadWorker: IWebWorkerService = {
		_serviceBrand: undefined,
		createWorkerClient: <T extends object>() => ({ proxy: new TextSlopWorker(), dispose: () => { } }) as unknown as IWebWorkerClient<T>,
		getWorkerUrl: () => '',
	};

	test('правки проекта читаются при каждой проверке, битый файл не выключает проверку, страница — по текстам', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const service = disposables.add(new VibeTextSlopService(fileService, new TestContextService(testWorkspace(URI.file('/ws'))), inThreadWorker, new TestConfigurationService()));
		const writeOverrides = (text: string) => fileService.writeFile(URI.file('/ws/.vibe/slop.json'), VSBuffer.fromString(text));
		const text = 'Стоит отметить, что сборка занимает две минуты.';

		const shipped = await service.check(text);
		const page = await service.pageFindings([text, 'Сервер отвечает за десять миллисекунд.', text, '   ']);
		await writeOverrides('{ "disable": ["RU-W2"] }');
		const disabled = await service.check(text);
		await writeOverrides('{ broken');
		const broken = await service.check(text);

		assert.deepStrictEqual({
			shipped: shipped?.report.findings.map(f => `${f.rule}:${f.line}`),
			page: page && [...page].map(([pageText, findings]) => [pageText.slice(0, 12), findings.map(f => f.rule)]),
			disabled: disabled?.report.findings.map(f => f.rule),
			broken: broken?.report.findings.map(f => f.rule),
			brokenSaid: broken?.warnings.map(w => w.split(':')[0]),
		}, {
			shipped: ['RU-W2:1'],
			page: [['Стоит отмети', ['RU-W2']], ['Сервер отвеч', []]],
			disabled: [],
			broken: ['RU-W2'],
			brokenSaid: ['slop.json'],
		});
	});
});
