/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


export const VIBE_SERVER_VIEWLET_ID = 'workbench.view.vibeServer';
export const VIBE_SERVER_VIEW_ID = 'workbench.view.vibeServer.control';

export const enum VibeServerCommands {
	start = 'vibeide.vibeServer.start',
	startEnvironment = 'vibeide.vibeServer.startEnvironment',
	stop = 'vibeide.vibeServer.stop',
	restart = 'vibeide.vibeServer.restart',
	openPreview = 'vibeide.vibeServer.openPreview',
	openPreviewNewTab = 'vibeide.vibeServer.openPreviewNewTab',
	reloadPreview = 'vibeide.vibeServer.reloadPreview',
	openExternal = 'vibeide.vibeServer.openExternal',
	copyUrl = 'vibeide.vibeServer.copyUrl',
	previewErrorsToChat = 'vibeide.vibeServer.previewErrorsToChat',
	showLanAddress = 'vibeide.vibeServer.showLanAddress',
	showLanQr = 'vibeide.vibeServer.showLanQr',
	openSettings = 'vibeide.vibeServer.openSettings',
}

/** True while a Vibe Server is running (drives status bar / menu visibility). */
export const VIBE_SERVER_RUNNING_CONTEXT_KEY = 'vibeServer.running';

/** Configuration section + keys. Single source of truth for reads and schema registration. */
export const VibeServerConfigKeys = {
	section: 'vibeide.vibeServer',
	port: 'vibeide.vibeServer.port',
	host: 'vibeide.vibeServer.host',
	root: 'vibeide.vibeServer.root',
	ignoreFiles: 'vibeide.vibeServer.ignoreFiles',
	cssHotReload: 'vibeide.vibeServer.cssHotReload',
	spaFallback: 'vibeide.vibeServer.spaFallback',
	previewTarget: 'vibeide.vibeServer.previewTarget',
	openAutomatically: 'vibeide.vibeServer.openAutomatically',
	showOnStatusbar: 'vibeide.vibeServer.showOnStatusbar',
	reloadDebounceMs: 'vibeide.vibeServer.reloadDebounceMs',
	autoNavigate: 'vibeide.vibeServer.autoNavigate',
	runtime: 'vibeide.vibeServer.runtime',
	devScript: 'vibeide.vibeServer.devScript',
	devServerStartTimeoutMs: 'vibeide.vibeServer.devServerStartTimeoutMs',
	dockerStartTimeoutMs: 'vibeide.vibeServer.dockerStartTimeoutMs',
	scrollSync: 'vibeide.vibeServer.scrollSync',
	https: 'vibeide.vibeServer.https',
} as const;

/** Where preview opens by default. */
export type VibeServerPreviewTarget = 'embedded' | 'external';
