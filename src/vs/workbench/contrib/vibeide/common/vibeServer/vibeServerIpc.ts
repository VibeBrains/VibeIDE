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
	/**
	 * The port the project asked for but found busy, when the dev-server fell back to `port`
	 * instead. Drives the port-conflict dialog; absent when the server got its own port.
	 */
	readonly requestedPort?: number;
	/**
	 * True when the served pages carry our bridge script (element inspect + design scan).
	 *
	 * The static server always injects it; a dev-server does only when the bridge proxy is in
	 * front of it. Preview UI must not offer inspect or measurement without it — "nothing found"
	 * and "nothing measured" are different answers.
	 */
	readonly bridgeInjected?: boolean;
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
	/**
	 * Cookie compat (VS.6): allow Set-Cookie rewriting to `SameSite=None; Secure` for a
	 * preview URL's origin while its tab is open (loopback-only; refcounted per tab).
	 * Without it, the cross-site preview iframe silently drops dev-site session cookies.
	 */
	registerPreviewOrigin(url: string): Promise<void>;
	/** Cookie compat (VS.6): drop the registration when its preview tab closes. */
	unregisterPreviewOrigin(url: string): Promise<void>;
	/**
	 * Starts a loopback proxy in front of a foreign dev-server and returns its URL.
	 *
	 * Why it exists: the bridge script (element inspect + design scan) is injected by OUR static
	 * server, so a Vite/Next preview had neither. The proxy passes everything through untouched
	 * except navigational HTML, where it appends the same script — the framework keeps its HMR
	 * (WebSocket upgrades and SSE are tunnelled verbatim), and the preview gains inspect and
	 * measurement. Returns the upstream URL unchanged when proxying is disabled.
	 */
	startBridgeProxy(options: IVibeBridgeProxyOptions): Promise<IVibeServerStarted>;
	/** Stops the bridge proxy. Safe to call when not running. */
	stopBridgeProxy(): Promise<void>;
}

export interface IVibeBridgeProxyOptions {
	/** Origin of the dev-server to sit in front of, e.g. `http://localhost:5173`. */
	readonly upstreamUrl: string;
	/** Bind host for the proxy — loopback, like the static server. */
	readonly host: string;
}
