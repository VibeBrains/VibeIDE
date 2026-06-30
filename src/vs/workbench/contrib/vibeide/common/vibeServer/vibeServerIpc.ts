/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * IPC contract for Vibe Server. The HTTP + live-reload server runs in electron-main
 * (node), the renderer drives it through {@link VIBE_SERVER_CHANNEL} via ProxyChannel.
 * Keep this file free of browser/node imports — pure data + signatures only.
 */

export const VIBE_SERVER_CHANNEL = 'vibeide-channel-vibeServer';

/** Runtime providers that can back a preview. Phase 0 ships {@link VibeServerRuntimeKind.static}. */
export const enum VibeServerRuntimeKind {
	static = 'static',
	devServer = 'devServer',
	docker = 'docker',
}

/** Kind of reload to broadcast to connected preview clients. */
export type VibeServerChangeKind = 'reload' | 'css';

export interface IVibeServerStartOptions {
	/** Absolute filesystem path served as the document root. */
	readonly rootFsPath: string;
	/** Bind host. Phase 0 keeps this at loopback (`127.0.0.1`) for safety. */
	readonly host: string;
	/** Desired port; the server walks upward from here on conflict. `0` = start from the default base. */
	readonly port: number;
	/** When set (relative path), unknown routes fall back to this file — enables SPA history routing. */
	readonly spaFallback: string;
	/** Serve over HTTPS with a generated self-signed certificate (secure-context features). */
	readonly https: boolean;
}

export interface IVibeServerStarted {
	readonly host: string;
	readonly port: number;
	/** `http://host:port/` — loopback URL of the running server. */
	readonly url: string;
}

/**
 * Main-process surface reachable from the renderer over {@link VIBE_SERVER_CHANNEL}.
 * A single server instance is managed at a time (Phase 0).
 */
export interface IVibeServerMain {
	/** Starts (or restarts) the static server and resolves with the bound address. */
	start(options: IVibeServerStartOptions): Promise<IVibeServerStarted>;
	/** Stops the server and releases the port. Safe to call when already stopped. */
	stop(): Promise<void>;
	/** Broadcasts a reload signal to connected preview clients. No-op when stopped. */
	notifyChange(kind: VibeServerChangeKind): Promise<void>;
	/** First non-internal IPv4 address of this machine, or undefined (for LAN/phone preview). */
	lanAddress(): Promise<string | undefined>;
}
