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
import { initModelsDevCatalogRequestService } from './llmMessage/modelsDevCatalog.js';
import { installVibeLogMainFileSink } from './vibeLogMainFileSink.js';
import { ModelQuirksStatusMainService } from './modelQuirksStatusMainService.js';
import { VibeIdleWatchdogChannelService } from './vibeIdleWatchdogChannel.js';
import { VIBE_IDLE_WATCHDOG_CHANNEL } from '../common/vibeIdleWatchdogTypes.js';
import { VibeWindowAttentionMainService } from './vibeWindowAttentionMainService.js';
import { VIBE_WINDOW_ATTENTION_CHANNEL } from '../common/vibeWindowAttentionIpc.js';
import { VibeTelegramMainService } from './telegram/vibeTelegramMainService.js';
import { VIBE_TELEGRAM_CHANNEL } from '../common/telegram/vibeTelegramTypes.js';
import { VIBE_HOOKS_CHANNEL } from '../common/hooks/vibeHookTypes.js';
import { VibeHooksMainService } from './hooks/vibeHooksMainService.js';
import { VibeServerMainService } from './vibeServer/vibeServerMainService.js';
import { VIBE_SERVER_CHANNEL } from '../common/vibeServer/vibeServerIpc.js';
import { VibeServerProcessService } from './vibeServer/vibeServerProcessService.js';
import { VIBE_SERVER_PROCESS_CHANNEL } from '../common/vibeServer/vibeServerProcessIpc.js';
import { VibeLogAdminMainService } from './vibeLogAdminMainService.js';
import { VIBE_LOG_ADMIN_CHANNEL } from '../common/vibeLogAdminIpc.js';
import { VibeVoiceMainService } from './voice/vibeVoiceMainService.js';
import { VibeVoiceChannel } from './voice/vibeVoiceChannel.js';
import { VIBE_VOICE_CHANNEL } from '../common/voice/vibeVoiceTypes.js';
import { VibeVideoMainService } from './video/vibeVideoMainService.js';
import { VibeVideoChannel } from './video/vibeVideoChannel.js';
import { VIBE_VIDEO_CHANNEL } from '../common/video/vibeVideoTypes.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
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
	// Persist main-process vibeLog to `<logsHome>/vibeide-main.log`. Wired first so the file
	// captures as much of the early-startup backlog as possible. The renderer's file sink
	// (vibeLogOutputChannel.ts) only sees renderer-side lines — this covers the main instance.
	disposables.add(installVibeLogMainFileSink(accessor.get(IEnvironmentMainService).logsHome.fsPath));

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

	// Logging-config push: renderer mirrors `vibeide.logging.*` + secret-detection snapshot
	// into main's vibeLog (see vibeLogConfigContribution.ts / vibeLogAdminMainService.ts).
	mainProcessElectronServer.registerChannel(VIBE_LOG_ADMIN_CHANNEL, ProxyChannel.fromService(new VibeLogAdminMainService(), disposables));

	const requestServiceMain = accessor.get(IRequestService);
	mainProcessElectronServer.registerChannel(
		'vibeide-channel-remoteCatalogFetch',
		new RemoteCatalogFetchChannel(requestServiceMain),
	);

	// Fetch the models.dev catalog through IRequestService (Electron `net` → system
	// proxy + system-trusted CAs), not raw undici, so it works on corporate networks.
	initModelsDevCatalogRequestService(requestServiceMain);

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

	mainProcessElectronServer.registerChannel(VIBE_HOOKS_CHANNEL, ProxyChannel.fromService(new VibeHooksMainService(), disposables));

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
		accessor.get(IConfigurationService),
	));
	mainProcessElectronServer.registerChannel(
		VIBE_SERVER_PROCESS_CHANNEL,
		ProxyChannel.fromService(vibeServerProcessService, disposables),
	);

	// Voice input — local STT: model store + utility-process lifecycle in main,
	// mic capture and ISpeechService provider in the renderer (electron-browser/voice/).
	const vibeVoiceMainService = disposables.add(new VibeVoiceMainService(
		accessor.get(ILogService),
		accessor.get(IEnvironmentMainService),
		accessor.get(IConfigurationService),
		accessor.get(ILifecycleMainService),
	));
	mainProcessElectronServer.registerChannel(VIBE_VOICE_CHANNEL, new VibeVoiceChannel(vibeVoiceMainService));

	// Video analysis (/watch) — tools store + yt-dlp/ffmpeg pipeline in main; the renderer
	// facade (electron-browser/video/) drives it and feeds frames to the chat vision request.
	// Reuses the voice service for the no-subtitles STT transcript fallback.
	const vibeVideoMainService = disposables.add(new VibeVideoMainService(
		accessor.get(ILogService),
		accessor.get(IEnvironmentMainService),
		accessor.get(IConfigurationService),
		vibeVoiceMainService,
	));
	mainProcessElectronServer.registerChannel(VIBE_VIDEO_CHANNEL, new VibeVideoChannel(vibeVideoMainService));

	// Telegram bridge: the poller belongs to the main process because there is exactly one per
	// application — two windows polling the same bot would collide on 409 Conflict. Created after
	// voice and video because transcription of voice messages reuses both (ffmpeg + offline STT)
	// instead of shipping a second decoder.
	const telegramService = disposables.add(new VibeTelegramMainService(
		accessor.get(ILogService),
		vibeVoiceMainService,
		vibeVideoMainService,
	));
	mainProcessElectronServer.registerChannel(
		VIBE_TELEGRAM_CHANNEL,
		ProxyChannel.fromService(telegramService, disposables),
	);
}

// Re-exported for `app.ts#configureSession()`: keeps the vs/code → vibeide bridge to the
// ONE import line this module already provides (code-import-patterns exemption surface).
export { maybeRewritePreviewCookies } from './vibeServer/vibeCookieCompatMain.js';
