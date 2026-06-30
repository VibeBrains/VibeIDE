/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';

import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface audit-log settings in VS Code's Settings UI. Without this block the
// keys read below by `_updateConfiguration` (and `vibeide.audit.encryptLogs`
// read by `vibeAuditEncryptionService.ts`) exist only via the `??` default,
// so users never see them in the editor and can't toggle audit logging without
// editing settings.json by hand. Defaults match the in-code fallbacks.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.audit.enable': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('vibeide.audit.enable', 'Включить локальный audit log агентских действий (prompts/replies/apply/undo/snapshot/git stash/MCP/subagent/plan-events). Off-by-default; включение требует явного согласия пользователя.'),
		},
		'vibeide.audit.path': {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('vibeide.audit.path', 'Абсолютный путь к каталогу audit log. Пустая строка — использовать managed userdata путь по умолчанию (рекомендуется). При указании кастомного пути файл создаётся под выбранным каталогом.'),
		},
		'vibeide.audit.rotationSizeMB': {
			type: 'number',
			default: 10,
			minimum: 1,
			maximum: 1000,
			scope: ConfigurationScope.APPLICATION,
			description: localize('vibeide.audit.rotationSizeMB', 'Порог ротации audit log в мегабайтах. При превышении текущий файл переименовывается с timestamp суффиксом и стартует новый. Значения вне [1..1000] игнорируются runtime-ом.'),
		},
		'vibeide.audit.encryptLogs': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('vibeide.audit.encryptLogs', 'Шифровать audit log через Electron safeStorage (per-user OS keychain). Замедляет запись; полезно если каталог логов синхронизируется в облако или подразумевается shared машина.'),
		},
	},
});

export interface AuditEvent {
	ts: number;
	user?: string;
	action: 'prompt' | 'reply' | 'diff_preview' | 'apply' | 'undo' | 'rollback' | 'snapshot:create' | 'snapshot:restore' | 'snapshot:discard' | 'git:stash' | 'git:stash:restore' | 'skill_suggestion'
	| 'plan_started' | 'plan_step_completed' | 'plan_failed' | 'plan_resumed'
	| 'advisory_territorial_lock'
	| 'subagent_spawned' | 'subagent_completed' | 'agent_route_started'
	| 'browser_run_proposed'
	| 'mcp_sampling_request'
	| 'background_job_budget_exceeded'
	| 'provider_failover_switch'
	| 'job_pr_creation'
	| 'run_tests:start' | 'run_tests:complete'
	| 'project_command:start' | 'project_command:complete' | 'project_command:trust_granted' | 'project_command:trust_revoked';
	files?: string[];
	diffStats?: { linesAdded: number; linesRemoved: number; hunks: number };
	model?: string;
	latencyMs?: number;
	ok: boolean;
	meta?: Record<string, unknown>;
}

export const IAuditLogService = createDecorator<IAuditLogService>('auditLogService');

export interface IAuditLogService {
	readonly _serviceBrand: undefined;
	append(event: AuditEvent): Promise<void>;
	isEnabled(): boolean;

	/** VibeIDE: Export all audit log entries as JSON string (GDPR data portability) */
	exportAll(): Promise<string>;

	/** VibeIDE: Delete all audit log files (GDPR right to erasure) */
	deleteAll(): Promise<void>;

	/** VibeIDE: Query recent audit events */
	queryRecent(limit?: number): Promise<AuditEvent[]>;
}

class AuditLogService extends Disposable implements IAuditLogService {
	declare readonly _serviceBrand: undefined;

	private _enabled = false;
	private _logPath: URI | null = null;
	private _pendingWrites: AuditEvent[] = [];
	private _writeScheduler: RunOnceScheduler;
	private _rotationSizeMB: number = 10;
	private _currentFileSize: number = 0;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
	) {
		super();
		this._writeScheduler = this._register(new RunOnceScheduler(() => this._flushWrites(), 100));
		this._updateConfiguration();
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.audit')) {
				this._updateConfiguration();
			}
		}));
	}

	private _updateConfiguration(): void {
		this._enabled = this._configurationService.getValue<boolean>('vibeide.audit.enable') ?? false;
		const customPath = this._configurationService.getValue<string>('vibeide.audit.path');
		this._rotationSizeMB = this._configurationService.getValue<number>('vibeide.audit.rotationSizeMB') ?? 10;

		if (!this._enabled) {
			this._logPath = null;
			return;
		}

		if (customPath) {
			this._logPath = URI.file(customPath);
		} else {
			const workspace = this._workspaceContextService.getWorkspace();
			if (workspace.folders.length > 0) {
				this._logPath = joinPath(workspace.folders[0].uri, '.vibe', 'audit.jsonl');
			} else {
				this._logPath = joinPath(this._environmentService.workspaceStorageHome, 'audit.jsonl');
			}
		}

		// Initialize log file if needed
		this._initializeLogFile().catch(err => {
			vibeLog.error('auditLog', '[AuditLog] Failed to initialize log file:', err);
		});
	}

	isEnabled(): boolean {
		return this._enabled;
	}

	/** VibeIDE: Export all audit log entries as JSON (GDPR data portability) */
	async exportAll(): Promise<string> {
		if (!this._logPath) { return '[]'; }
		try {
			// Flush pending writes first
			await this._flushWrites();
			const content = await this._fileService.readFile(this._logPath);
			const lines = content.value.toString().trim().split('\n').filter(Boolean);
			const events = lines.map(line => {
				try { return JSON.parse(line) as AuditEvent; } catch { return null; }
			}).filter(Boolean);
			return JSON.stringify(events, null, 2);
		} catch {
			return '[]';
		}
	}

	/** VibeIDE: Delete all audit log files (GDPR right to erasure) */
	async deleteAll(): Promise<void> {
		if (!this._logPath) { return; }
		try {
			await this._flushWrites();
			// Delete main log file
			try { await this._fileService.del(this._logPath); } catch { /* may not exist */ }
			// Delete rotated log files (*.N.jsonl, *.N.jsonl.gz)
			const parent = this._logPath.with({ path: this._logPath.path.split('/').slice(0, -1).join('/') });
			const dir = await this._fileService.resolve(parent);
			const baseName = this._logPath.path.split('/').pop() ?? '';
			if (dir.children) {
				for (const child of dir.children) {
					if (child.name.startsWith(baseName.replace('.jsonl', ''))) {
						try { await this._fileService.del(child.resource); } catch { /* ignore */ }
					}
				}
			}
			this._logPath = null;
			this._enabled = false;
			vibeLog.info('AuditLog', 'All audit logs deleted (GDPR erasure)');
		} catch (e) {
			vibeLog.error('AuditLog', 'Failed to delete audit logs:', e);
		}
	}

	/** VibeIDE: Query recent audit events */
	async queryRecent(limit: number = 100): Promise<AuditEvent[]> {
		if (!this._logPath) { return []; }
		try {
			await this._flushWrites();
			const content = await this._fileService.readFile(this._logPath);
			const lines = content.value.toString().trim().split('\n').filter(Boolean);
			const events = lines.map(line => {
				try { return JSON.parse(line) as AuditEvent; } catch { return null; }
			}).filter(Boolean) as AuditEvent[];
			return events.slice(-limit);
		} catch {
			return [];
		}
	}

	async append(event: AuditEvent): Promise<void> {
		if (!this._enabled || !this._logPath) {
			return;
		}

		this._pendingWrites.push(event);
		this._writeScheduler.schedule();
	}

	private async _initializeLogFile(): Promise<void> {
		if (!this._logPath) { return; }

		const parentDir = this._logPath.with({ path: this._logPath.path.replace(/\/[^/]*$/, '') });
		try {
			await this._fileService.createFolder(parentDir);
		} catch {
			// Folder might already exist
		}

		// Check current file size
		try {
			const stat = await this._fileService.stat(this._logPath);
			this._currentFileSize = stat.size;
		} catch {
			// File doesn't exist yet, will be created on first write
			this._currentFileSize = 0;
		}
	}

	private async _flushWrites(): Promise<void> {
		if (this._pendingWrites.length === 0 || !this._logPath) {
			return;
		}

		const events = this._pendingWrites.splice(0);
		const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
		const buffer = VSBuffer.fromString(lines);
		const sizeBytes = buffer.byteLength;

		// Check if rotation needed
		if (this._currentFileSize + sizeBytes > this._rotationSizeMB * 1024 * 1024) {
			await this._rotateLogFile();
		}

		try {
			// Append to file (non-blocking)
			// Read existing content and append
			let existingContent = VSBuffer.fromString('');
			try {
				const existing = await this._fileService.readFile(this._logPath);
				existingContent = existing.value;
			} catch {
				// File doesn't exist yet, that's fine
			}
			const combined = VSBuffer.concat([existingContent, buffer]);
			await this._fileService.writeFile(this._logPath, combined);
			this._currentFileSize += sizeBytes;
		} catch (err) {
			vibeLog.error('auditLog', '[AuditLog] Failed to write audit log:', err);
		}
	}

	private async _rotateLogFile(): Promise<void> {
		if (!this._logPath) { return; }

		try {
			// Read current file
			const content = await this._fileService.readFile(this._logPath);
			const contentBuffer = content.value.buffer;

			// Compress with gzip (using Node.js zlib, available in Electron main process)
			// For browser context, we'll skip compression and just rotate
			let compressed: Buffer;
			try {
				const zlib = await import('zlib');
				const { promisify: promisifyNode } = await import('util');
				const gzip = promisifyNode(zlib.gzip);
				compressed = await gzip(Buffer.from(contentBuffer));
			} catch {
				// zlib not available (browser context), use uncompressed
				compressed = Buffer.from(contentBuffer);
			}

			// Find next rotation number
			let rotationNum = 1;
			let rotatedPath: URI;
			do {
				const extension = compressed.length < contentBuffer.byteLength ? '.gz' : '';
				rotatedPath = this._logPath.with({ path: this._logPath.path.replace(/\.jsonl$/, `.${rotationNum}.jsonl${extension}`) });
				rotationNum++;
			} while (await this._fileService.exists(rotatedPath));

			// Write compressed file
			await this._fileService.writeFile(rotatedPath, VSBuffer.wrap(compressed));

			// Create new empty log file
			await this._fileService.writeFile(this._logPath, VSBuffer.fromString(''));
			this._currentFileSize = 0;

			vibeLog.debug('auditLog', `[AuditLog] Rotated log file to ${rotatedPath.path}`);
		} catch (err) {
			vibeLog.error('auditLog', '[AuditLog] Failed to rotate log file:', err);
		}
	}
}

registerSingleton(IAuditLogService, AuditLogService, InstantiationType.Delayed);

