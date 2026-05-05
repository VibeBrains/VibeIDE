/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export const IVibeCheckpointCoordinator = createDecorator<IVibeCheckpointCoordinator>('vibeCheckpointCoordinator');

export interface IVibeCheckpointCoordinator {
	readonly _serviceBrand: undefined;
	/** Label of the holder currently running inside runExclusive (undefined between ops). For diagnostics only. */
	readonly exclusiveHolderLabel: string | undefined;

	/**
	 * Serialize snapshot-related mutations for one workspace (single chain per workbench).
	 * Used by rollback snapshots, worktree merge hooks, multi-agent checkpoint stubs, and chat-thread checkpoints.
	 */
	runExclusive<T>(opts: { op: string; holderLabel?: string }, fn: () => Promise<T>): Promise<T>;
}

export class VibeCheckpointCoordinator extends Disposable implements IVibeCheckpointCoordinator {
	declare readonly _serviceBrand: undefined;

	private _chain: Promise<void> = Promise.resolve();
	private _exclusiveHolderLabel: string | undefined;

	get exclusiveHolderLabel(): string | undefined {
		return this._exclusiveHolderLabel;
	}

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	async runExclusive<T>(opts: { op: string; holderLabel?: string }, fn: () => Promise<T>): Promise<T> {
		const who = opts.holderLabel ?? 'anon';
		const prev = this._chain;
		let release!: () => void;
		const gate = new Promise<void>(res => {
			release = res;
		});
		this._chain = prev.then(() => gate);
		if (this._exclusiveHolderLabel !== undefined) {
			this._logService.trace(`[VibeCheckpointCoordinator] wait ${opts.op} (${who}) whileHeldBy=${this._exclusiveHolderLabel}`);
		}
		await prev;
		this._exclusiveHolderLabel = who;
		this._logService.trace(`[VibeCheckpointCoordinator] acquire ${opts.op} (${who})`);
		try {
			return await fn();
		} finally {
			this._exclusiveHolderLabel = undefined;
			this._logService.trace(`[VibeCheckpointCoordinator] release ${opts.op} (${who})`);
			release();
		}
	}
}

registerSingleton(IVibeCheckpointCoordinator, VibeCheckpointCoordinator, InstantiationType.Delayed);
