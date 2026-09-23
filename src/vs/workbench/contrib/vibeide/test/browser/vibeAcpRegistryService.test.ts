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
import { TestPathService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { VibeAcpRegistryService } from '../../browser/acp/vibeAcpRegistryService.js';
import { IMCPService } from '../../common/mcpService.js';

suite('VibeAcpRegistryService — правка agents.json на лету', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	// The project file is inside the workspace, and its changes come on the shared event of the recursive
	// workspace watcher: a correlated watcher of its own stayed silent on macOS under `/Volumes`.
	test('агент, дописанный в проектный agents.json, появляется без перезапуска', async () => {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const service = disposables.add(new VibeAcpRegistryService(
			fileService,
			new TestContextService(testWorkspace(URI.file('/ws'))),
			new class extends mock<IMCPService>() { },
			new TestPathService(URI.file('/home')),
			new TestConfigurationService(),
		));
		await service.reload();

		const listed = Event.toPromise(Event.filter(service.onDidChange, () => service.agents.length > 0));
		await fileService.writeFile(URI.file('/ws/.vibe/agents.json'), VSBuffer.fromString(JSON.stringify({
			agents: [{ id: 'probe', name: 'Probe', command: '/bin/probe' }],
		})));
		await listed;

		assert.deepStrictEqual(service.agents.map(agent => ({ id: agent.id, layer: service.layerOf(agent.id) })), [{ id: 'probe', layer: 'project' }]);
	});
});
