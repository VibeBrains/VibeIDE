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
	/** Polls a TCP port until it accepts a connection or the timeout elapses (readiness check). */
	waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean>;
}
