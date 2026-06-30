/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Server as ElectronIPCServer } from '../../../../base/parts/ipc/electron-main/ipc.electron.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
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
import { ModelQuirksStatusMainService } from './modelQuirksStatusMainService.js';
import { VibeIdleWatchdogChannelService } from './vibeIdleWatchdogChannel.js';
import { VIBE_IDLE_WATCHDOG_CHANNEL } from '../common/vibeIdleWatchdogTypes.js';
import { VibeWindowAttentionMainService } from './vibeWindowAttentionMainService.js';
import { VIBE_WINDOW_ATTENTION_CHANNEL } from '../common/vibeWindowAttentionIpc.js';
import { VibeServerMainService } from './vibeServer/vibeServerMainService.js';
import { VIBE_SERVER_CHANNEL } from '../common/vibeServer/vibeServerIpc.js';
import { VibeServerProcessService } from './vibeServer/vibeServerProcessService.js';
import { VIBE_SERVER_PROCESS_CHANNEL } from '../common/vibeServer/vibeServerProcessIpc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';

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

	const modelQuirksStatusService = new ModelQuirksStatusMainService();
	mainProcessElectronServer.registerChannel(
		'vibeide-channel-modelQuirksStatus',
		ProxyChannel.fromService(modelQuirksStatusService, disposables),
	);

	// Idle Watchdog — IPC channel for renderer / ext-host samples (roadmap W.1/W.2).
	// The channel service is a thin shim; actual writes go through the main-process
	// singleton instance started in `src/main.ts` via `startVibeIdleWatchdog()`.
	// Also bridges main-side slope-detector to a renderer-listenable Event (W.5).
	const idleWatchdogChannelService = disposables.add(new VibeIdleWatchdogChannelService());
	mainProcessElectronServer.registerChannel(
		VIBE_IDLE_WATCHDOG_CHANNEL,
		ProxyChannel.fromService(idleWatchdogChannelService, disposables),
	);

	const windowAttentionService = disposables.add(new VibeWindowAttentionMainService(
		accessor.get(IWindowsMainService),
		accessor.get(ILogService),
	));
	mainProcessElectronServer.registerChannel(
		VIBE_WINDOW_ATTENTION_CHANNEL,
		ProxyChannel.fromService(windowAttentionService, disposables),
	);

	// Vibe Server — static document server + live reload (roadmap VS.2). Node http/ws lives
	// in main; the renderer drives lifecycle and pushes file-change signals over this channel.
	const vibeServerMainService = disposables.add(new VibeServerMainService(accessor.get(ILogService)));
	mainProcessElectronServer.registerChannel(
		VIBE_SERVER_CHANNEL,
		ProxyChannel.fromService(vibeServerMainService, disposables),
	);

	// Vibe Server process runner — dev-servers (VS.4) and `docker compose` (VS.5).
	const vibeServerProcessService = disposables.add(new VibeServerProcessService(
		accessor.get(ILogService),
		accessor.get(IEnvironmentMainService),
	));
	mainProcessElectronServer.registerChannel(
		VIBE_SERVER_PROCESS_CHANNEL,
		ProxyChannel.fromService(vibeServerProcessService, disposables),
	);
}
