/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Multi-window coordinator (roadmap L.4 L1032).
 *
 * Two VibeIDE instances on the same workspace race on .vibe/ writes. This contribution
 * claims or observes ownership via `.vibe/.window-lock.json`:
 *
 *   first-owner / owner    → write lock, start 20-second heartbeat (TTL 60s).
 *   takeover-candidate     → stale/dead owner → confirm dialog → write new lock.
 *   observer               → valid foreign lock → watch agent-locks.json read-only.
 *
 * Pure decision logic: common/windowLockPolicy.ts (18 unit-tests).
 * Atomic writes use IFileService `{ atomic: { postfix: '.vibe-tmp' } }`.
 */

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import {
	WindowLock,
	buildWindowLock,
	decideWindowRole,
	decodeWindowLock,
	refreshWindowLockHeartbeat,
} from '../common/windowLockPolicy.js';
import { safeParseConfigJson } from '../common/vibeConfigJsonParser.js';

const HEARTBEAT_INTERVAL_MS = 20_000;
const LOCK_TTL_MS = 60_000;

export class VibeMultiWindowCoordinatorContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeMultiWindowCoordinator';

	private readonly _windowId = generateUuid();
	private _lock: WindowLock | null = null;
	private _heartbeatTimer: number | null = null;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IDialogService private readonly _dialogService: IDialogService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		void this._init();
	}

	private async _init(): Promise<void> {
		const folders = this._workspace.getWorkspace().folders;
		if (folders.length === 0) {
			return;
		}
		const lockUri = joinPath(folders[0].uri, '.vibe', '.window-lock.json');

		let existingLock: WindowLock | null = null;
		try {
			const buf = await this._fileService.readFile(lockUri);
			const parsed = safeParseConfigJson(buf.value.toString());
			if (parsed.ok) {
				existingLock = decodeWindowLock(parsed.value);
			}
		} catch {
			// File missing → first-owner (normal on first launch).
		}

		const now = Date.now();
		const currentPid = typeof process !== 'undefined' ? process.pid : 0;

		let isPidAlive: ((pid: number) => boolean) | undefined;
		if (typeof process !== 'undefined' && typeof (process as NodeJS.Process).kill === 'function') {
			isPidAlive = (pid: number) => {
				try { process.kill(pid, 0); return true; } catch { return false; }
			};
		}

		const decision = decideWindowRole({
			now,
			currentPid,
			currentWindowId: this._windowId,
			lock: existingLock,
			ttlMs: LOCK_TTL_MS,
			isPidAlive,
		});

		this._log.info(`[VibeMultiWindowCoordinator] startup: role=${decision.role} reason=${decision.reason} windowId=${this._windowId}`);

		switch (decision.role) {
			case 'first-owner':
			case 'owner':
				await this._claimOwnership(lockUri, now, currentPid);
				break;

			case 'takeover-candidate': {
				const staleForSec = Math.round(decision.staleByMs / 1000);
				const result = await this._dialogService.confirm({
					message: localize('vibeide.multiWindow.takeover.title', 'VibeIDE — перехватить управление workspace?'),
					detail: localize(
						'vibeide.multiWindow.takeover.detail',
						'Другой экземпляр VibeIDE был последним владельцем, но его heartbeat устарел на {0} сек. Принять управление и стать owner?',
						staleForSec,
					),
					primaryButton: localize('vibeide.multiWindow.takeover.confirm', 'Принять'),
				});
				if (result.confirmed) {
					await this._claimOwnership(lockUri, now, currentPid);
				} else {
					this._becomeObserver(folders[0].uri);
				}
				break;
			}

			case 'observer':
				this._becomeObserver(folders[0].uri);
				break;
		}
	}

	private async _claimOwnership(lockUri: URI, now: number, pid: number): Promise<void> {
		this._lock = buildWindowLock(pid, now, this._windowId);
		await this._writeLock(lockUri);
		this._startHeartbeat(lockUri);
		this._log.info(`[VibeMultiWindowCoordinator] owner (pid=${pid} windowId=${this._windowId})`);
	}

	private _becomeObserver(folderUri: URI): void {
		const agentLocksUri = joinPath(folderUri, '.vibe', 'agent-locks.json');
		this._register(this._fileService.watch(agentLocksUri));
		this._log.info(`[VibeMultiWindowCoordinator] observer — watching ${agentLocksUri.toString()} (read-only mode)`);
	}

	private _startHeartbeat(lockUri: URI): void {
		this._heartbeatTimer = mainWindow.setInterval(() => {
			if (!this._lock) {
				return;
			}
			this._lock = refreshWindowLockHeartbeat(this._lock, Date.now());
			void this._writeLock(lockUri).catch((e: unknown) => {
				this._log.warn(`[VibeMultiWindowCoordinator] heartbeat write failed: ${(e instanceof Error ? e.message : String(e))}`);
			});
		}, HEARTBEAT_INTERVAL_MS);
		this._register({
			dispose: () => {
				if (this._heartbeatTimer !== null) {
					mainWindow.clearInterval(this._heartbeatTimer);
					this._heartbeatTimer = null;
				}
			},
		});
	}

	private async _writeLock(lockUri: URI): Promise<void> {
		if (!this._lock) {
			return;
		}
		await this._fileService.writeFile(
			lockUri,
			VSBuffer.fromString(JSON.stringify(this._lock, null, 2) + '\n'),
			{ atomic: { postfix: '.vibe-tmp' } },
		);
	}
}

registerWorkbenchContribution2(
	VibeMultiWindowCoordinatorContribution.ID,
	VibeMultiWindowCoordinatorContribution,
	WorkbenchPhase.AfterRestored,
);
