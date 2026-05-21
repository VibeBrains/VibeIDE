/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Server as ElectronIPCServer } from '../../../../base/parts/ipc/electron-main/ipc.electron.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IApplicationStorageMainService } from '../../../../platform/storage/electron-main/storageMainService.js';
import { IUpdateService } from '../../../../platform/update/common/update.js';

import { VibeideSCMService } from './vibeideSCMMainService.js';
import { VibeideMainUpdateService } from './vibeideUpdateMainService.js';
import { LLMMessageChannel } from './sendLLMMessageChannel.js';
import { MCPChannel } from './mcpChannel.js';
import { MetricsMainService } from './metricsMainService.js';
import { OllamaInstallerChannel } from './ollamaInstallerChannel.js';
import { RemoteCatalogFetchChannel } from './remoteCatalogFetchChannel.js';
import { ModelsDevCatalogStatusMainService } from './modelsDevCatalogStatusMainService.js';

/**
 * Registers IPC channels expected by workbench contrib/vibeide (renderer).
 * Must stay in sync with channel names in common/*Channel*.ts and *Service.ts proxies.
 */
export function registerVibeideMainProcessChannels(
	accessor: ServicesAccessor,
	mainProcessElectronServer: ElectronIPCServer,
	disposables: DisposableStore,
): void {
	// Token is typed as IStorageMainService; runtime is ApplicationStorageMainService (IApplicationStorageMainService).
	const applicationStorage = accessor.get(IApplicationStorageMainService) as unknown as IApplicationStorageMainService;
	const metricsMainService = disposables.add(new MetricsMainService(
		accessor.get(IProductService),
		accessor.get(IEnvironmentMainService),
		applicationStorage,
		accessor.get(ILogService),
	));

	mainProcessElectronServer.registerChannel('vibe-channel-metrics', ProxyChannel.fromService(metricsMainService, disposables));

	const llmChannel = new LLMMessageChannel(metricsMainService);
	mainProcessElectronServer.registerChannel('vibeide-channel-llmMessage', llmChannel);

	const requestServiceMain = accessor.get(IRequestService);
	mainProcessElectronServer.registerChannel(
		'vibeide-channel-remoteCatalogFetch',
		new RemoteCatalogFetchChannel(requestServiceMain),
	);

	const mcpChannel = new MCPChannel();
	mainProcessElectronServer.registerChannel('vibe-channel-mcp', mcpChannel);

	const scmService = disposables.add(new VibeideSCMService());
	mainProcessElectronServer.registerChannel('vibeide-channel-scm', ProxyChannel.fromService(scmService, disposables));

	const vibeideUpdateService = disposables.add(new VibeideMainUpdateService(
		accessor.get(IProductService),
		accessor.get(IEnvironmentMainService),
		accessor.get(IUpdateService),
		accessor.get(IConfigurationService),
		accessor.get(IRequestService),
	));
	mainProcessElectronServer.registerChannel('vibeide-channel-update', ProxyChannel.fromService(vibeideUpdateService, disposables));

	const ollamaInstallerChannel = new OllamaInstallerChannel();
	mainProcessElectronServer.registerChannel('vibe-channel-ollamaInstaller', ollamaInstallerChannel);

	const modelsDevCatalogStatusService = new ModelsDevCatalogStatusMainService();
	mainProcessElectronServer.registerChannel(
		'vibeide-channel-modelsDevCatalogStatus',
		ProxyChannel.fromService(modelsDevCatalogStatusService, disposables),
	);
}
