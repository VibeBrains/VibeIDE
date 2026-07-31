/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * IPC contract for the Vibe Server process runner — spawns long-running child processes
 * (framework dev-servers in VS.4, `docker compose` in VS.5) in electron-main and streams their
 * output back to the renderer. Pure data + signatures; no node/browser imports.
 */

import { Event } from '../../../../../base/common/event.js';

export const VIBE_SERVER_PROCESS_CHANNEL = 'vibeide-channel-vibeServerProcess';

export interface IVibeServerProcSpec {
	/** Caller-assigned id used to correlate output/exit events and to stop the process. */
	readonly id: string;
	readonly command: string;
	readonly args: readonly string[];
	/** Absolute working directory. */
	readonly cwd: string;
	/** Environment overlay merged on top of the main-process environment. */
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * Directories prepended to the resolved `PATH` (pins a toolchain, e.g. a specific Node version).
	 * Applied in main after the login-shell PATH is resolved, so it wins over the ambient toolchain.
	 */
	readonly pathPrepend?: readonly string[];
}

export interface IVibeServerProcOutput {
	readonly id: string;
	readonly stream: 'stdout' | 'stderr';
	readonly data: string;
}

export interface IVibeServerProcExit {
	readonly id: string;
	readonly code: number | null;
	readonly signal: string | null;
}

/** A process listening on a loopback port (for the port-conflict dialog). */
export interface IVibeServerPortOwner {
	readonly pid: number;
	/** Command line of the owner; empty when the process listing did not resolve it. */
	readonly commandLine: string;
	/**
	 * Project directory when the owner is a dev-server managed by this VibeIDE instance
	 * (any window) — lets the dialog warn before killing a sibling project's server.
	 */
	readonly vibeCwd?: string;
}

export interface IVibeServerProcessMain {
	/** Fires for every chunk of child stdout/stderr. */
	readonly onDidOutput: Event<IVibeServerProcOutput>;
	/** Fires once when a child exits (for any reason). */
	readonly onDidExit: Event<IVibeServerProcExit>;
	/** Spawns the process. Rejects if it cannot be started. */
	start(spec: IVibeServerProcSpec): Promise<void>;
	/**
	 * Reports the loopback port the spawned dev-server bound, once known. Lets termination target
	 * the port owner — reliable even when intermediate shells (npm/cmd) exit and detach the worker
	 * from the originally spawned PID.
	 */
	notePort(id: string, host: string, port: number): Promise<void>;
	/** Terminates the process and its child tree. Safe when already gone. */
	stop(id: string): Promise<void>;
	/** Describes the processes listening on a loopback port; empty when the port is free. */
	describePortOwners(port: number): Promise<IVibeServerPortOwner[]>;
	/** Kills every process (with its tree) listening on the port. Safe when the port is free. */
	killPort(port: number): Promise<void>;
	/** Polls a TCP port until it accepts a connection or the timeout elapses (readiness check). */
	waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean>;
	/**
	 * Polls an HTTP(S) URL until it answers with a non-5xx status or the timeout elapses. Runs in
	 * main (not the renderer) so the loopback probe is not subject to the workbench CSP. TLS is not
	 * verified — dev servers routinely use self-signed certificates.
	 */
	waitForHttp(url: string, timeoutMs: number): Promise<boolean>;
}
