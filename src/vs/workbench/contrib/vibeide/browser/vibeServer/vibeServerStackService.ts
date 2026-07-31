/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Multi-server orchestrator contract. Drives the project's dev stack declared in
 * `.vibe/servers.json`: reads the file, holds a live status per entry, and starts an entry together
 * with its `dependsOn` prerequisites (in the waves computed by the pure core in
 * `common/vibeServer/vibeServersFile.ts`). The single-server `IVibeServerService` is untouched —
 * it stays the behaviour when no `.vibe/servers.json` exists.
 *
 * Contract lives in `browser/` (four UI consumers import it); the desktop implementation reaching
 * the process channel + file system lives in `electron-browser/vibeServer/vibeServerStackService.ts`.
 */

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { VibeServerEntry } from '../../common/vibeServer/vibeServersFile.js';

export const IVibeServerStackService = createDecorator<IVibeServerStackService>('vibeServerStackService');

/** Lifecycle of a single stack entry, as tracked by the orchestrator. */
export type VibeServerEntryState =
	/** Not started (or stopped). */
	| 'stopped'
	/** Process spawned; waiting for its readiness check. */
	| 'starting'
	/** Ready — for a service its port/URL accepts; for a task it exited 0. */
	| 'running'
	/** Spawn failed, exited non-zero, or readiness timed out. */
	| 'failed'
	/** Left out of any start plan: unknown/inactive dependency, or a dependency cycle. */
	| 'excluded';

/** UI-facing snapshot of one entry: its declaration plus its current runtime status. */
export interface IVibeServerStackEntry {
	readonly entry: VibeServerEntry;
	readonly state: VibeServerEntryState;
	/** Loopback URL (`http://localhost:<port>`) once the service is running; undefined otherwise. */
	readonly url?: string;
	/** Human-readable reason for `failed`/`excluded`, shown as a tooltip. */
	readonly detail?: string;
}

export interface IVibeServerStackService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the entry list or any entry's state changes. */
	readonly onDidChangeStack: Event<void>;

	/** True when a valid `.vibe/servers.json` was loaded (drives whether the list UI shows at all). */
	readonly available: boolean;

	/** Current entries with their live state, in file order. Empty when unavailable. */
	readonly entries: readonly IVibeServerStackEntry[];

	/** Non-fatal parse warnings from the last load (skipped entries, duplicates). */
	readonly warnings: readonly string[];

	/** (Re)reads `.vibe/servers.json` from the workspace root and refreshes {@link entries}. */
	reload(): Promise<void>;

	/** Starts one entry together with its transitive `dependsOn`, wave by wave. */
	startEntry(id: string): Promise<void>;

	/** Stops one entry (best-effort; its `stopCommand` runs too). Dependants are left running. */
	stopEntry(id: string): Promise<void>;

	/** Starts the whole stack in dependency order. */
	startAll(): Promise<void>;

	/** Stops every running entry. */
	stopAll(): Promise<void>;

	/** Preview URL for a running service (`url` + its `previewPath`), or undefined when not previewable. */
	previewUrlFor(id: string): string | undefined;
}
