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
import { AUDIT_CHAIN_ROOT, AuditChainVerdict, chainRecord, chainTailOf, estimateChainedSize, verifyAuditChain } from './auditChain.js';
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

/**
 * Who caused the event.
 *
 * A log that records only WHAT happened cannot answer the question that matters after an incident:
 * did a person do this, or did the agent do it on their behalf? NIST puts it plainly — sharing one
 * identity between a human and an agent «creates accountability gaps», and an agent should be a
 * first-class subject with its own identifier rather than a shadow of the user's.
 *
 *   - `human`    — the person acted directly (typed a prompt, accepted a diff, granted trust).
 *   - `agent`    — the main agent acted inside a turn, on the person's behalf.
 *   - `subagent` — a delegated role acted; `actorId` names which one.
 *   - `system`   — VibeIDE itself acted with nobody asking (rotation, breaker recovery, schedules).
 */
export type AuditActor = 'human' | 'agent' | 'subagent' | 'system';

export interface AuditEvent {
	ts: number;
	/**
	 * Required on purpose. An optional field would be left unset at half the call sites — which is
	 * exactly what happened to the `user` field it replaces: declared, and never once filled in.
	 */
	actor: AuditActor;
	/** Which delegate acted — subagent role, plan id, run id. Absent for `human` and `system`. */
	actorId?: string;
	action: 'prompt' | 'reply' | 'diff_preview' | 'apply' | 'undo' | 'rollback' | 'snapshot:create' | 'snapshot:restore' | 'snapshot:discard' | 'git:stash' | 'git:stash:restore' | 'skill_suggestion'
	| 'plan_started' | 'plan_step_completed' | 'plan_failed' | 'plan_resumed'
	| 'advisory_territorial_lock'
	| 'circuit_breaker_opened' | 'circuit_breaker_recovered'
	| 'subagent_spawned' | 'subagent_completed' | 'agent_route_started'
	| 'browser_run_proposed'
	| 'mcp_sampling_request'
	| 'background_job_budget_exceeded'
	| 'provider_failover_switch'
	| 'job_pr_creation'
	| 'run_tests:start' | 'run_tests:complete'
	| 'verify_gate:result'
	| 'project_command:start' | 'project_command:complete' | 'project_command:trust_granted' | 'project_command:trust_revoked'
	// Agent tool access. Arguments and command bodies are never recorded — see `toolCallAudit.ts`.
	| 'tool_call:start' | 'tool_call:done';
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

	/**
	 * Check the hash chain of the current log.
	 *
	 * Writing the chain and never offering to read it would be theatre: the file would carry
	 * evidence nobody can look at. `undefined` when logging is off or the file does not exist yet —
	 * that is «nothing to check», not «checked and fine», and the caller must not conflate them.
	 */
	verifyIntegrity(): Promise<AuditChainVerdict | undefined>;
}

class AuditLogService extends Disposable implements IAuditLogService {
	declare readonly _serviceBrand: undefined;

	private _enabled = false;
	private _logPath: URI | null = null;
	/** Where the log lived before it was moved out of the agent's reach; migrated once on startup. */
	private _legacyLogPath: URI | undefined;
	/** Hash of the last written record — the link the next one points back to. */
	private _chainTail: string = AUDIT_CHAIN_ROOT;
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
			// No migration into a folder the user picked: moving their old log there is a decision
			// we were not asked to make, and a stale value here would do exactly that after the
			// setting changed mid-session.
			this._legacyLogPath = undefined;
		} else {
			// Managed userdata, NOT `<workspace>/.vibe/audit.jsonl`.
			//
			// The log used to live in the working folder — inside the reach of the agent's own file
			// tools, which is exactly the surface an agent goes for when it wants its trail gone. In
			// the OpenAI/Hugging Face incident agents edited and deleted logs inside their container
			// and tried to trigger an environment reset to wipe history (METR, 2026-08-26). A record
			// the recorded party can rewrite is not a record.
			//
			// Kept per workspace (subfolder by workspace id) so projects do not bleed into one
			// shared file — that was the one thing the old location got right.
			const workspace = this._workspaceContextService.getWorkspace();
			this._logPath = workspace.folders.length > 0
				? joinPath(this._environmentService.workspaceStorageHome, workspace.id, 'audit.jsonl')
				: joinPath(this._environmentService.workspaceStorageHome, 'audit.jsonl');
			this._legacyLogPath = workspace.folders.length > 0
				? joinPath(workspace.folders[0].uri, '.vibe', 'audit.jsonl')
				: undefined;
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

		await this._migrateLegacyLog();

		// Check current file size, and pick up where the chain left off. Without reading the tail a
		// restart would start a fresh chain from the root and the verifier would report a break at
		// the first line written after it — a false accusation, and the worst kind for this file.
		try {
			const stat = await this._fileService.stat(this._logPath);
			this._currentFileSize = stat.size;
			const existing = await this._fileService.readFile(this._logPath);
			this._chainTail = chainTailOf(existing.value.toString().split('\n'));
		} catch {
			// File doesn't exist yet, will be created on first write
			this._currentFileSize = 0;
			this._chainTail = AUDIT_CHAIN_ROOT;
		}
	}

	/**
	 * Move a pre-existing `<workspace>/.vibe/audit.jsonl` to the managed location, once.
	 *
	 * Silently abandoning it would be the wrong kind of quiet: that file is somebody's history, and
	 * leaving a copy behind keeps it editable by the very agent the log is about. Moving is only
	 * safe while the destination is still empty — if both exist we touch neither and say so, because
	 * merging two append-only logs by guesswork would corrupt the order of events in both.
	 */
	private async _migrateLegacyLog(): Promise<void> {
		const legacy = this._legacyLogPath;
		if (!legacy || !this._logPath) {
			return;
		}
		this._legacyLogPath = undefined; // once per configuration change, not once per write
		try {
			if (!(await this._fileService.exists(legacy))) {
				return;
			}
			if (await this._fileService.exists(this._logPath)) {
				vibeLog.warn('auditLog', `[AuditLog] старый лог остался в рабочей папке (${legacy.fsPath}): в новом месте уже есть журнал, сливать два append-only лога наугад нельзя — перенесите или удалите вручную`);
				return;
			}
			await this._fileService.move(legacy, this._logPath);
			vibeLog.info('auditLog', `[AuditLog] журнал перенесён из рабочей папки в ${this._logPath.fsPath} — там он вне досягаемости файловых инструментов агента`);
		} catch (err) {
			vibeLog.error('auditLog', '[AuditLog] не удалось перенести старый журнал:', err);
		}
	}

	private async _flushWrites(): Promise<void> {
		if (this._pendingWrites.length === 0 || !this._logPath) {
			return;
		}

		const events = this._pendingWrites.splice(0);

		// Rotate FIRST, then chain. The other order looked harmless and was not: the records were
		// linked to the tail of the file being archived, then landed in the fresh one — whose very
		// first line pointed at a hash living in the archive, so the new log failed verification
		// from line 1. Rotation is judged on the serialized size, so measure it before deciding.
		const sizeBytes = estimateChainedSize(events, this._chainTail);
		if (this._currentFileSize + sizeBytes > this._rotationSizeMB * 1024 * 1024) {
			await this._rotateLogFile();
		}

		// Chain the batch: every record carries the hash of the one before it, so a line cut out of
		// the middle stops adding up at a nameable place instead of vanishing without trace.
		const chained: string[] = [];
		for (const event of events) {
			const { line, hash } = chainRecord(event, this._chainTail);
			chained.push(line);
			this._chainTail = hash;
		}
		const buffer = VSBuffer.fromString(chained.join('\n') + '\n');

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
			this._currentFileSize += buffer.byteLength;
		} catch (err) {
			vibeLog.error('auditLog', '[AuditLog] Failed to write audit log:', err);
		}
	}

	async verifyIntegrity(): Promise<AuditChainVerdict | undefined> {
		if (!this._enabled || !this._logPath) {
			return undefined;
		}
		// Flush first: records still sitting in the buffer are not in the file, and a verdict on a
		// half-written file would accuse the log of a gap we made ourselves.
		await this._flushWrites();
		try {
			const content = await this._fileService.readFile(this._logPath);
			return verifyAuditChain(content.value.toString().split('\n'));
		} catch {
			return undefined;
		}
	}

	private async _rotateLogFile(): Promise<void> {
		if (!this._logPath) { return; }

		try {
			// Read current file
			const content = await this._fileService.readFile(this._logPath);
			const contentBuffer = content.value.buffer;

			// Compress with gzip (Node.js zlib, available in the Electron main process). Browser/worker
			// contexts have no zlib, so fall back to uncompressed. The module specifiers are held in
			// variables so TypeScript resolves the dynamic imports to `any` — this keeps the
			// common-layer file free of @types/node while the runtime guard (try/catch) stays intact.
			let compressed: Uint8Array = contentBuffer;
			try {
				// `'zlib' as string` keeps the specifier a literal for the bundler (external node builtin)
				// while TypeScript resolves the import to `any`, so no @types/node is pulled into common/.
				const zlib = await import('zlib' as string) as { gzip: (buf: Uint8Array, cb: (err: unknown, res: Uint8Array) => void) => void };
				const { promisify: promisifyNode } = await import('util' as string) as { promisify: (fn: typeof zlib.gzip) => (buf: Uint8Array) => Promise<Uint8Array> };
				const gzip = promisifyNode(zlib.gzip);
				compressed = await gzip(contentBuffer);
			} catch {
				// zlib not available (browser/worker context) — keep uncompressed.
				compressed = contentBuffer;
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

			// Create new empty log file. The chain restarts from the root here: the rotated part is a
			// closed file of its own and verifies on its own terms, while a link pointing into an
			// archive would make every fresh log unverifiable without it.
			await this._fileService.writeFile(this._logPath, VSBuffer.fromString(''));
			this._currentFileSize = 0;
			this._chainTail = AUDIT_CHAIN_ROOT;

			vibeLog.debug('auditLog', `[AuditLog] Rotated log file to ${rotatedPath.path}`);
		} catch (err) {
			vibeLog.error('auditLog', '[AuditLog] Failed to rotate log file:', err);
		}
	}
}

registerSingleton(IAuditLogService, AuditLogService, InstantiationType.Delayed);

