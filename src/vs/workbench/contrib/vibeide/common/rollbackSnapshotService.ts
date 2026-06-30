/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';

import { IAuditLogService } from './auditLogService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibeCheckpointCoordinator } from './vibeCheckpointCoordinatorService.js';
import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface rollback-snapshot settings in VS Code's Settings UI. Without this
// block both keys read by `_updateConfiguration` exist only via the `??`
// defaults, so users never see them in the editor and can't enable the
// snapshot/rollback safety net without editing settings.json by hand.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.safety.rollback.enable': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.safety.rollback.enable', 'Включить snapshot/rollback safety net перед агентскими правками. Off-by-default: снапшоты пишутся в `.vibe/snapshots/` и могут занимать заметный объём — включение требует явного согласия.'),
		},
		'vibeide.safety.rollback.maxSnapshotBytes': {
			type: 'number',
			default: 5_000_000,
			minimum: 100_000,
			maximum: 100_000_000,
			description: localize('vibeide.safety.rollback.maxSnapshotBytes', 'Soft-cap размера одного снапшота в байтах (default 5 МБ). Файлы крупнее не включаются в snapshot — backed off с warning, чтобы `.vibe/snapshots/` не вырос неконтролируемо.'),
		},
	},
});

export interface FileSnapshot {
	path: string;
	content: string;
	mtime: number;
}

export interface Snapshot {
	id: string;
	createdAt: number;
	files: FileSnapshot[];
	skipped?: boolean;
}

export const IRollbackSnapshotService = createDecorator<IRollbackSnapshotService>('rollbackSnapshotService');

export interface IRollbackSnapshotService {
	readonly _serviceBrand: undefined;
	isEnabled(): boolean;
	createSnapshot(files: string[]): Promise<Snapshot>;
	restoreSnapshot(id: string): Promise<void>;
	discardSnapshot(id: string): Promise<void>;
	getLastSnapshot(): Snapshot | undefined;
}

class RollbackSnapshotService extends Disposable implements IRollbackSnapshotService {
	declare readonly _serviceBrand: undefined;

	private _enabled = false;
	private _maxSnapshotBytes = 50_000_000; // VibeIDE: increased from 5MB to 50MB
	private _snapshots = new Map<string, Snapshot>();
	private _lastSnapshotId: string | undefined;
	private _snapshotsDirUri: URI | null = null;
	private _persistenceReady = false;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IVibeCheckpointCoordinator private readonly _checkpointCoordinator: IVibeCheckpointCoordinator,
	) {
		super();
		this._updateConfiguration();
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.safety.rollback')) {
				this._updateConfiguration();
			}
		}));
		// VibeIDE: Initialize file-based persistence
		this._initPersistence();
	}

	/** VibeIDE: Set up .vibe/snapshots/ directory and load existing snapshots from disk */
	private async _initPersistence(): Promise<void> {
		try {
			const workspaceFolders = this._workspaceContextService.getWorkspace().folders;
			if (workspaceFolders.length === 0) { return; }

			const workspaceRoot = workspaceFolders[0].uri;
			this._snapshotsDirUri = joinPath(workspaceRoot, '.vibe', 'snapshots');

			// Ensure directory exists
			try {
				await this._fileService.createFolder(this._snapshotsDirUri);
			} catch {
				// Directory may already exist — ignore
			}

			// Load existing snapshots from disk into memory
			const dir = await this._fileService.resolve(this._snapshotsDirUri);
			if (dir.children) {
				for (const child of dir.children) {
					if (child.name.endsWith('.json')) {
						try {
							const content = await this._fileService.readFile(child.resource);
							const snapshot = JSON.parse(content.value.toString()) as Snapshot;
							this._snapshots.set(snapshot.id, snapshot);
							if (!this._lastSnapshotId || snapshot.createdAt > (this._snapshots.get(this._lastSnapshotId)?.createdAt ?? 0)) {
								this._lastSnapshotId = snapshot.id;
							}
						} catch (e) {
							vibeLog.warn('RollbackSnapshot', `Failed to load snapshot ${child.name}:`, e);
						}
					}
				}
			}

			this._persistenceReady = true;
			vibeLog.info('RollbackSnapshot', `Loaded ${this._snapshots.size} snapshots from disk`);
		} catch (e) {
			vibeLog.warn('RollbackSnapshot', 'Failed to initialize persistence, using in-memory only:', e);
		}
	}

	/** VibeIDE: Persist a snapshot to .vibe/snapshots/ */
	private async _persistSnapshot(snapshot: Snapshot): Promise<void> {
		if (!this._snapshotsDirUri || !this._persistenceReady) { return; }
		try {
			const snapshotUri = joinPath(this._snapshotsDirUri, `${snapshot.id}.json`);
			await this._fileService.writeFile(snapshotUri, VSBuffer.fromString(JSON.stringify(snapshot, null, 2)));
		} catch (e) {
			vibeLog.warn('RollbackSnapshot', `Failed to persist snapshot ${snapshot.id}:`, e);
		}
	}

	/** VibeIDE: Remove a snapshot file from disk */
	private async _deleteSnapshotFile(id: string): Promise<void> {
		if (!this._snapshotsDirUri) { return; }
		try {
			const snapshotUri = joinPath(this._snapshotsDirUri, `${id}.json`);
			await this._fileService.del(snapshotUri);
		} catch {
			// File may not exist — ignore
		}
	}

	private _updateConfiguration(): void {
		this._enabled = this._configurationService.getValue<boolean>('vibeide.safety.rollback.enable') ?? false;
		this._maxSnapshotBytes = this._configurationService.getValue<number>('vibeide.safety.rollback.maxSnapshotBytes') ?? 5_000_000;
	}

	isEnabled(): boolean {
		return this._enabled;
	}

	async createSnapshot(files: string[]): Promise<Snapshot> {
		if (!this._enabled) {
			throw new Error('Rollback snapshot service is disabled');
		}

		return this._checkpointCoordinator.runExclusive({ op: 'rollback:createSnapshot' }, async () => {
			return this._createSnapshotBody(files);
		});
	}

	private async _createSnapshotBody(files: string[]): Promise<Snapshot> {
		const snapshotId = `snapshot-${Date.now()}-${Math.random().toString(36).substring(7)}`;
		const fileSnapshots: FileSnapshot[] = [];
		let totalBytes = 0;
		let skipped = false;

		for (const filePath of files) {
			const uri = URI.file(filePath);
			try {
				// Try to read from buffer (dirty editor) first, else disk
				let content: string;
				let mtime: number;

				const modelRef = await this._textModelService.createModelReference(uri);
				try {
					const textModel = modelRef.object.textEditorModel;
					if (textModel && !textModel.isDisposed()) {
						// Check if model is dirty by comparing with file content
						// For simplicity, we'll always read from model if available, else from disk
						content = textModel.getValue();
						mtime = Date.now(); // Use current time for model content
					} else {
						const stat = await this._fileService.stat(uri);
						const fileContent = await this._fileService.readFile(uri);
						content = fileContent.value.toString();
						mtime = stat.mtime;
					}
				} finally {
					modelRef.dispose();
				}

				const fileBytes = new TextEncoder().encode(content).length;
				if (totalBytes + fileBytes > this._maxSnapshotBytes) {
					skipped = true;
					vibeLog.warn('rollbackSnapshot', `[RollbackSnapshot] Snapshot exceeded max size, skipping remaining files`);
					break;
				}

				fileSnapshots.push({ path: filePath, content, mtime });
				totalBytes += fileBytes;
			} catch (error) {
				vibeLog.warn('rollbackSnapshot', `[RollbackSnapshot] Failed to snapshot ${filePath}:`, error);
				// Continue with other files
			}
		}

		const snapshot: Snapshot = {
			id: snapshotId,
			createdAt: Date.now(),
			files: fileSnapshots,
			skipped,
		};

		this._snapshots.set(snapshotId, snapshot);
		this._lastSnapshotId = snapshotId;

		// VibeIDE: Persist to .vibe/snapshots/ for crash recovery
		await this._persistSnapshot(snapshot);

		// Audit log
		if (this._auditLogService.isEnabled()) {
			await this._auditLogService.append({
				ts: Date.now(),
				action: 'snapshot:create',
				files: fileSnapshots.map(f => f.path),
				ok: true,
				meta: {
					snapshotId,
					bytes: totalBytes,
					skipped,
				},
			});
		}

		return snapshot;
	}

	async restoreSnapshot(id: string): Promise<void> {
		return this._checkpointCoordinator.runExclusive({ op: 'rollback:restoreSnapshot', holderLabel: id }, async () => {
			await this._restoreSnapshotBody(id);
		});
	}

	private async _restoreSnapshotBody(id: string): Promise<void> {
		const snapshot = this._snapshots.get(id);
		if (!snapshot) {
			throw new Error(`Snapshot ${id} not found`);
		}

		try {
			for (const fileSnap of snapshot.files) {
				const uri = URI.file(fileSnap.path);
				try {
					// Write to both buffer (if open) and disk
					const modelRef = await this._textModelService.createModelReference(uri);
					try {
						const textModel = modelRef.object.textEditorModel;
						if (textModel && !textModel.isDisposed()) {
							textModel.setValue(fileSnap.content);
						}
					} finally {
						modelRef.dispose();
					}

					// Also write to disk
					await this._fileService.writeFile(uri, VSBuffer.fromString(fileSnap.content));
				} catch (error) {
					vibeLog.error('rollbackSnapshot', `[RollbackSnapshot] Failed to restore ${fileSnap.path}:`, error);
					// Continue with other files
				}
			}

			// Audit log
			if (this._auditLogService.isEnabled()) {
				await this._auditLogService.append({
					ts: Date.now(),
					action: 'snapshot:restore',
					files: snapshot.files.map(f => f.path),
					ok: true,
					meta: { snapshotId: id },
				});
			}
		} catch (error) {
			if (this._auditLogService.isEnabled()) {
				await this._auditLogService.append({
					ts: Date.now(),
					action: 'snapshot:restore',
					ok: false,
					meta: { snapshotId: id, error: String(error) },
				});
			}
			throw error;
		}
	}

	async discardSnapshot(id: string): Promise<void> {
		return this._checkpointCoordinator.runExclusive({ op: 'rollback:discardSnapshot', holderLabel: id }, async () => {
			await this._discardSnapshotBody(id);
		});
	}

	private async _discardSnapshotBody(id: string): Promise<void> {
		this._snapshots.delete(id);
		if (this._lastSnapshotId === id) {
			this._lastSnapshotId = undefined;
		}

		// VibeIDE: Remove from disk
		await this._deleteSnapshotFile(id);

		if (this._auditLogService.isEnabled()) {
			await this._auditLogService.append({
				ts: Date.now(),
				action: 'snapshot:discard',
				ok: true,
				meta: { snapshotId: id },
			});
		}
	}

	getLastSnapshot(): Snapshot | undefined {
		return this._lastSnapshotId ? this._snapshots.get(this._lastSnapshotId) : undefined;
	}
}

registerSingleton(IRollbackSnapshotService, RollbackSnapshotService, InstantiationType.Delayed);

