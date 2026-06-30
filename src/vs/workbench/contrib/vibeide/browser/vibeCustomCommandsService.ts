/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands runtime — `IVibeCustomCommandsService`.
 *
 * Wires up the pure helpers that already shipped (decoder, secrets resolver,
 * global-paths merger, terminal-launch decider) into a workbench singleton:
 *
 *   .vibe/commands.json (each workspace root) + vibeide.commands.globalPaths
 *      └─► decodeProjectCommandsFile + mergeProjectCommandsByPriority
 *      └─► snapshot in memory + DidChangeCommandsEvent
 *      └─► run(id):
 *            ├─ resolveProjectCommandSecrets (env: / secret: placeholders)
 *            ├─ ITerminalService.createTerminal (integrated path)
 *            └─ DidStartCommandEvent → DidEndCommandEvent
 *
 * **Phase scope (this commit):**
 *  - Multi-root FS watch on `.vibe/commands.json`.
 *  - Global paths read from `vibeide.commands.globalPaths` (workspace wins).
 *  - Secret placeholder resolution via `IEncryptionService` (secret:) + `process.env` (env:).
 *  - Integrated-terminal spawn via `ITerminalService` (background / external — backlog).
 *  - Events: DidChange / DidStart / DidEnd (success/failure tracked via `onExit`).
 *
 * **Deferred (separate roadmap items):**
 *  - Trust confirm dialog + `.vibe/commands.trust.json` writes.
 *  - Audit log redaction + `IVibeAuditLogService` hookup.
 *  - Dynamic `vibeide.commands.run.<id>` registration in `CommandsRegistry`.
 *  - Status-bar indicator + top-bar pinned-buttons contribution.
 *
 * Per-file lock: a singleton service spans windows; cross-window writes to
 * `.vibe/commands.json` are handled by the FS-watcher debounce.
 */

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import {
	ProjectCommand,
	decodeProjectCommandsFile,
} from '../common/projectCommandsTypes.js';
import {
	decodeProjectCommandsGlobalPaths,
	mergeProjectCommandsByPriority,
} from '../common/projectCommandsGlobalPaths.js';
import {
	DidChangeCommandsEvent,
	DidEndCommandEvent,
	DidStartCommandEvent,
} from '../common/projectCommandsServiceContract.js';
import { resolveProjectCommandSecrets, PLACEHOLDER_RE, findSuspiciousLiteralSecrets } from '../common/projectCommandSecretsResolver.js';
import {
	decideRunConfirm,
	describeConfirmReason,
	buildTrustEntryAfterApproval,
} from '../common/projectCommandsTrustConfirm.js';
import {
	CommandTrustEntry,
	decodeCommandTrustEntries,
	decideTrustRevocations,
	buildTrustRevokeAuditEntries,
} from '../common/commandTrustRevoke.js';
import {
	decodeAuditFlags,
	redactCommandForAudit,
} from '../common/commandsAuditPrivacy.js';
import { IAuditLogService } from '../common/auditLogService.js';
import { decideWorkflowTrigger } from '../common/projectCommandsWorkflowTrigger.js';
import { IVibeWorkflowService } from '../common/vibeWorkflowService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { decideProjectCommandLaunch, detectLaunchOS } from '../common/projectCommandsTerminalPolicy.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import Severity from '../../../../base/common/severity.js';
import { safeParseConfigJson } from '../common/vibeConfigJsonParser.js';
import { IVibeConstraintsService } from '../common/vibeConstraintsService.js';
import {
	checkCommandConstraints,
	checkCwdTraversal,
	describeIssue,
	sanitizeProjectCommand,
} from '../common/projectCommandsSanitizer.js';

const COMMANDS_FILE_NAME = '.vibe/commands.json';
const TRUST_FILE_NAME = '.vibe/commands.trust.json';
const WATCHER_DEBOUNCE_MS = 250;
/**
 * Notify only when the suspect-id set changes between reloads — otherwise
 * a single committed leak would re-warn on every editor save. Kept on the
 * instance (see `_lastSuspectIds`).
 */

/**
 * Cheap stable hash of the parts of a ProjectCommand that affect trust.
 * Re-runs require re-approval when any of these change. Args + env order is
 * preserved (Object.entries already returns insertion order in modern V8).
 * Avoids crypto deps for a workbench-side trust file.
 */
function hashCommandShape(c: Pick<ProjectCommand, 'command' | 'args' | 'cwd' | 'env' | 'shell'>): string {
	const parts = [
		c.command,
		(c.args ?? []).join('\x1f'),
		c.cwd ?? '',
		Object.entries(c.env ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\x1f'),
		c.shell ? '1' : '0',
	];
	const s = parts.join('\x1e');
	// FNV-1a 32-bit — fast, no crypto. The trust file is local-only; collision
	// resistance against an adversarial attacker isn't a threat model here.
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

export const IVibeCustomCommandsService = createDecorator<IVibeCustomCommandsService>('vibeCustomCommandsService');

export interface RunCommandOutcome {
	readonly outcome: 'success' | 'failure' | 'cancelled' | 'refused';
	readonly reason?: string;
	readonly unresolvedPlaceholders?: ReadonlyArray<{ kind: 'env' | 'secret'; name: string }>;
	readonly invocationId: string;
	readonly exitCode?: number;
}

export interface IVibeCustomCommandsService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeCommands: Event<DidChangeCommandsEvent>;
	readonly onDidStartCommand: Event<DidStartCommandEvent>;
	readonly onDidEndCommand: Event<DidEndCommandEvent>;

	/** Current merged snapshot of available commands (workspace wins over globals). */
	getCommands(): ReadonlyArray<ProjectCommand>;

	/** Find a command by id; returns undefined when not present. */
	getCommand(id: string): ProjectCommand | undefined;

	/** Re-scan all sources from disk and update the snapshot. Idempotent. */
	reload(): Promise<void>;

	/** Run a command by id. Returns once the spawned terminal process has exited. */
	run(id: string): Promise<RunCommandOutcome>;

	/** Return ids of all currently-trusted commands (from .vibe/commands.trust.json). */
	getTrustedCommandIds(): Promise<readonly string[]>;

	/**
	 * Explicitly revoke trust for a command by id.
	 * Also prunes orphaned / shape-changed entries as a side-effect.
	 */
	revokeTrust(id: string): Promise<void>;
}

class VibeCustomCommandsService extends Disposable implements IVibeCustomCommandsService {
	declare readonly _serviceBrand: undefined;

	private _merged: ProjectCommand[] = [];
	private _initialised = false;
	/** Tracks running singleton command ids to enforce the singleton constraint. */
	private readonly _runningSingletonIds = new Set<string>();
	/** Dynamic watchers for `vibeide.commands.globalPaths` files (L306). Replaced on config change. */
	private readonly _globalPathWatcherStore = this._register(new DisposableStore());
	/** Last reload's suspect-secret command ids — used to suppress repeat warnings (L914). */
	private _lastSuspectIds: ReadonlySet<string> = new Set();

	private readonly _onDidChangeCommands = this._register(new Emitter<DidChangeCommandsEvent>());
	readonly onDidChangeCommands: Event<DidChangeCommandsEvent> = this._onDidChangeCommands.event;

	private readonly _onDidStartCommand = this._register(new Emitter<DidStartCommandEvent>());
	readonly onDidStartCommand: Event<DidStartCommandEvent> = this._onDidStartCommand.event;

	private readonly _onDidEndCommand = this._register(new Emitter<DidEndCommandEvent>());
	readonly onDidEndCommand: Event<DidEndCommandEvent> = this._onDidEndCommand.event;

	private readonly _reloadDebouncer = this._register(new RunOnceScheduler(() => {
		void this._reload('fs-change');
	}, WATCHER_DEBOUNCE_MS));

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@ILogService private readonly _log: ILogService,
		@ITerminalService private readonly _terminal: ITerminalService,
		@IDialogService private readonly _dialog: IDialogService,
		@IAuditLogService private readonly _audit: IAuditLogService,
		@IVibeWorkflowService private readonly _workflows: IVibeWorkflowService,
		@ISecretStorageService private readonly _secrets: ISecretStorageService,
		@INotificationService private readonly _notification: INotificationService,
		@IVibeConstraintsService private readonly _constraints: IVibeConstraintsService,
	) {
		super();

		// Initial load + FS watcher.
		void this._reload('init');

		this._register(this._fileService.onDidFilesChange(e => {
			const roots = this._workspace.getWorkspace().folders.map(f => f.uri);
			const touched = roots.some(root => e.contains(joinPath(root, ...COMMANDS_FILE_NAME.split('/'))));
			if (touched) {
				this._reloadDebouncer.schedule();
			}
		}));

		// Workspace folder add/remove changes the set of files to watch.
		this._register(this._workspace.onDidChangeWorkspaceFolders(() => this._reloadDebouncer.schedule()));

		// Settings change to vibeide.commands.globalPaths invalidates the merged snapshot.
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.commands.globalPaths')) {
				void this._reload('global-paths-change');
			}
		}));
	}

	getCommands(): ReadonlyArray<ProjectCommand> {
		return this._merged;
	}

	getCommand(id: string): ProjectCommand | undefined {
		return this._merged.find(c => c.id === id);
	}

	async reload(): Promise<void> {
		await this._reload('manual-reload');
	}

	private async _reload(source: DidChangeCommandsEvent['source']): Promise<void> {
		const workspaceCommands = await this._loadWorkspaceCommands();
		const globalCommands = await this._loadGlobalCommands();
		const merged = mergeProjectCommandsByPriority(workspaceCommands, globalCommands);
		this._merged = [...merged.merged];
		this._initialised = true;
		this._onDidChangeCommands.fire({ commands: this._merged, source });
		if (merged.shadowedGlobalIds.length > 0) {
			this._log.info(`[VibeCustomCommands] ${merged.shadowedGlobalIds.length} global commands shadowed by workspace: ${merged.shadowedGlobalIds.join(', ')}`);
		}
		// L306: keep FS watchers in sync with current globalPaths setting.
		this._updateGlobalPathWatchers();
		// Prune orphaned / shape-changed trust entries on every reload (roadmap K.2 L920).
		void this._pruneTrustOnLoad();
		// L914: scan the freshly-loaded commands for plaintext-looking secrets.
		// Catches direct edits of `.vibe/commands.json` (which bypass the React form
		// editor / Tasks-json import / community-import gates).
		this._notifySuspectSecrets();
	}

	/**
	 * L914 — emit a single Warning toast when a new command appears with a
	 * plaintext-looking literal secret. Only fires when the set of suspect ids
	 * changed since the previous reload, so a single uncorrected leak doesn't
	 * spam the user on every editor save.
	 */
	private _notifySuspectSecrets(): void {
		const suspectsByCmd: { id: string; name: string; pathHint: string }[] = [];
		for (const cmd of this._merged) {
			const hits = findSuspiciousLiteralSecrets({
				command: cmd.command,
				args: cmd.args,
				cwd: cmd.cwd,
				env: cmd.env,
			});
			if (hits.length > 0) {
				suspectsByCmd.push({ id: cmd.id, name: cmd.name, pathHint: hits[0].pathHint });
			}
		}
		const nextIds = new Set(suspectsByCmd.map(s => s.id));
		const newOnes = suspectsByCmd.filter(s => !this._lastSuspectIds.has(s.id));
		this._lastSuspectIds = nextIds;
		if (newOnes.length === 0) { return; }
		const first = newOnes[0];
		this._notification.notify({
			severity: Severity.Warning,
			message: newOnes.length === 1
				? localize(
					'vibeide.commands.secretSuspect.single',
					'«{0}»: подозрение на plaintext-секрет в {1}. Используйте ${secret:KEY} вместо инлайнового значения.',
					first.name, first.pathHint,
				)
				: localize(
					'vibeide.commands.secretSuspect.many',
					'Обнаружены подозрения на plaintext-секреты в {0} командах (первая: «{1}» в {2}). Используйте ${secret:KEY}.',
					newOnes.length, first.name, first.pathHint,
				),
		});
	}

	/** Watch every file listed in `vibeide.commands.globalPaths` so on-disk edits trigger a reload. */
	private _updateGlobalPathWatchers(): void {
		this._globalPathWatcherStore.clear();
		const raw = this._config.getValue('vibeide.commands.globalPaths');
		const decoded = decodeProjectCommandsGlobalPaths(raw);
		for (const p of decoded.entries) {
			try {
				this._globalPathWatcherStore.add(this._fileService.watch(URI.file(p)));
			} catch {
				// Non-existent paths can't be watched — they'll be loaded on next reload.
			}
		}
	}

	async getTrustedCommandIds(): Promise<readonly string[]> {
		const entries = await this._readTrustEntries();
		return entries.map(e => e.id);
	}

	async revokeTrust(id: string): Promise<void> {
		const trust = await this._readTrustEntries();
		const commands = this._merged.map(c => ({ id: c.id, commandShapeHash: hashCommandShape(c) }));
		const result = decideTrustRevocations({ trust, commands, explicitlyRevokedId: id });
		await this._writeTrustEntries(result.keep);
		for (const entry of buildTrustRevokeAuditEntries(result)) {
			void this._audit.append({
				ts: Date.now(),
				action: 'project_command:trust_revoked',
				ok: true,
				meta: entry,
			});
		}
	}

	private async _pruneTrustOnLoad(): Promise<void> {
		const trust = await this._readTrustEntries();
		if (trust.length === 0) { return; }
		const commands = this._merged.map(c => ({ id: c.id, commandShapeHash: hashCommandShape(c) }));
		const result = decideTrustRevocations({ trust, commands });
		if (result.revoke.length === 0) { return; }
		await this._writeTrustEntries(result.keep);
		for (const entry of buildTrustRevokeAuditEntries(result)) {
			void this._audit.append({
				ts: Date.now(),
				action: 'project_command:trust_revoked',
				ok: true,
				meta: entry,
			});
		}
		this._log.info(`[VibeCustomCommands] pruned ${result.revoke.length} stale trust entries`);
	}

	private async _loadWorkspaceCommands(): Promise<ProjectCommand[]> {
		const folders = this._workspace.getWorkspace().folders;
		const out: ProjectCommand[] = [];
		for (const folder of folders) {
			const uri = joinPath(folder.uri, ...COMMANDS_FILE_NAME.split('/'));
			const file = await this._readAndDecode(uri);
			if (file) {
				out.push(...file.commands);
			}
		}
		return out;
	}

	private async _loadGlobalCommands(): Promise<ProjectCommand[]> {
		const raw = this._config.getValue('vibeide.commands.globalPaths');
		const decoded = decodeProjectCommandsGlobalPaths(raw);
		if (decoded.skipped.length > 0) {
			this._log.warn(`[VibeCustomCommands] vibeide.commands.globalPaths: ${decoded.skipped.length} entries skipped (${decoded.skipped.map(s => s.reason).join(', ')})`);
		}
		const out: ProjectCommand[] = [];
		for (const p of decoded.entries) {
			try {
				const uri = URI.file(p);
				const file = await this._readAndDecode(uri);
				if (file) {
					out.push(...file.commands);
				}
			} catch (e) {
				this._log.warn(`[VibeCustomCommands] global path failed to load: ${p}: ${(e as Error).message}`);
			}
		}
		return out;
	}

	private async _readAndDecode(uri: URI): Promise<{ commands: ProjectCommand[] } | undefined> {
		let buf;
		try {
			buf = await this._fileService.readFile(uri);
		} catch {
			// Missing file is the common case — no commands defined yet.
			return undefined;
		}
		// L304: JSONC-tolerant parse — `.vibe/commands.json` may carry `//` comments
		// after the user's hand-edits. Empty / corrupt files fall back to "no commands".
		const parseResult = safeParseConfigJson(buf.value.toString());
		if (!parseResult.ok) {
			if (parseResult.reason !== 'empty') {
				this._log.warn(`[VibeCustomCommands] ${uri.toString()} parse failed: ${parseResult.reason}`);
			}
			return undefined;
		}
		const decoded = decodeProjectCommandsFile(parseResult.value);
		if (!decoded.ok) {
			this._log.warn(`[VibeCustomCommands] ${uri.toString()} decode failed: ${decoded.reason}`);
			return undefined;
		}
		return { commands: [...decoded.value.commands] };
	}

	async run(id: string): Promise<RunCommandOutcome> {
		if (!this._initialised) {
			await this._reload('init');
		}
		const invocationId = generateUuid();
		const cmd = this._merged.find(c => c.id === id);
		if (!cmd) {
			return { outcome: 'refused', reason: 'unknown-command-id', invocationId };
		}

		// Pre-fetch all ${secret:KEY} placeholders from ISecretStorageService (async).
		// We collect unique keys first so each key is fetched at most once.
		const secretKeys = new Set<string>();
		const allStrings = [
			cmd.command,
			...(cmd.args ?? []),
			cmd.cwd ?? '',
			...Object.values(cmd.env ?? {}),
		];
		const scanRe = new RegExp(PLACEHOLDER_RE.source, 'g');
		for (const s of allStrings) {
			for (let m = scanRe.exec(s); m !== null; m = scanRe.exec(s)) {
				if (m[1] === 'secret') { secretKeys.add(m[2]); }
			}
		}
		const secretMap = new Map<string, string>();
		for (const key of secretKeys) {
			const val = await this._secrets.get(`vibeide.commands.secret.${key}`);
			if (val !== undefined) { secretMap.set(key, val); }
		}

		// Resolve ${env:NAME} / ${secret:KEY} placeholders.
		const resolveResult = resolveProjectCommandSecrets(
			{
				command: cmd.command,
				args: cmd.args,
				cwd: cmd.cwd,
				env: cmd.env,
			},
			{
				env: (name: string) => {
					try {
						return process.env[name];
					} catch {
						return undefined;
					}
				},
				secret: (key: string) => secretMap.get(key),
			},
		);

		if (resolveResult.unresolved.length > 0) {
			this._log.warn(`[VibeCustomCommands] refused ${id}: ${resolveResult.unresolved.length} unresolved placeholder(s)`);
			return {
				outcome: 'refused',
				reason: 'unresolved-placeholders',
				unresolvedPlaceholders: resolveResult.unresolved.map(u => ({ kind: u.kind, name: u.name })),
				invocationId,
			};
		}

		// L333: pre-launch sanitizer + constraints gate.
		// Re-run the static sanitizer on the *resolved* command (placeholder
		// substitution may have introduced shell-metachar or zero-width chars
		// from process.env). Then ask IVibeConstraintsService whether the cwd
		// (resolved relative to workspace root) is denied by .vibe/constraints.json.
		const resolvedForSan: ProjectCommand = {
			...cmd,
			command: resolveResult.resolved.command,
			args: resolveResult.resolved.args,
			cwd: resolveResult.resolved.cwd,
			env: resolveResult.resolved.env,
		};
		const traversalIssue = resolvedForSan.cwd ? checkCwdTraversal(resolvedForSan.cwd) : null;
		const sanResult = sanitizeProjectCommand(resolvedForSan);
		const constraintIssues = checkCommandConstraints(resolvedForSan, this._constraints);
		const allIssues = [
			...(traversalIssue ? [traversalIssue] : []),
			...sanResult.issues,
			...constraintIssues,
		];
		if (allIssues.length > 0) {
			const first = describeIssue(allIssues[0]);
			this._log.warn(`[VibeCustomCommands] refused ${id}: sanitizer: ${first}`);
			this._notification.notify({
				severity: Severity.Warning,
				message: localize(
					'vibeide.commands.sanitizer.refused',
					'Команда «{0}» отклонена санитайзером: {1}',
					cmd.name, first,
				),
			});
			return {
				outcome: 'refused',
				reason: `sanitizer:${allIssues[0].kind}`,
				invocationId,
			};
		}

		// ── Workflow trigger gate (roadmap L344) ─────────────────────────────
		// If the command points to a workflow, validate the id + existence and
		// refuse early. Without a runtime workflow-runner API (workflows are
		// surfaced via chat `/workflow:name`), we refuse with a clear reason
		// asking the user to invoke the workflow through chat instead.
		if (cmd.workflowId !== undefined) {
			const workflows = await this._workflows.getWorkflows();
			const known = new Set(workflows.map(w => w.name));
			const decision = decideWorkflowTrigger({ command: cmd, knownWorkflowIds: known });
			if (decision.kind === 'refused') {
				this._log.warn(`[VibeCustomCommands] refused ${id}: workflow ${decision.reason}`);
				return { outcome: 'refused', reason: `workflow-${decision.reason}`, invocationId };
			}
			if (decision.kind === 'launch-workflow') {
				const runResult = await this._workflows.run(decision.workflowId);
				if (!runResult.dispatched) {
					return {
						outcome: 'refused',
						reason: `workflow-not-found:${decision.workflowId}`,
						invocationId,
					};
				}
				return { outcome: 'success', invocationId };
			}
			// kind === 'launch-shell' → fall through to normal terminal path
		}

		// ── Trust confirm gate (roadmap L331) ────────────────────────────────
		const currentHash = hashCommandShape(cmd);
		const trustEntries = await this._readTrustEntries();
		const trustEntry = trustEntries.find(t => t.id === cmd.id);
		const confirmDecision = decideRunConfirm({ command: cmd, currentHash, trustEntry });
		if (confirmDecision.kind === 'require-confirm') {
			const body = describeConfirmReason(confirmDecision.reason, cmd.name);
			const confirmed = await this._dialog.confirm({
				message: localize('vibeide.commands.runConfirm.title', 'Project Commands — подтверждение запуска'),
				detail: body,
				primaryButton: localize('vibeide.commands.runConfirm.primary', 'Запустить'),
				type: confirmDecision.reason === 'shape-changed-since-trust' ? 'warning' : 'info',
			});
			if (!confirmed.confirmed) {
				return { outcome: 'cancelled', reason: 'user-rejected-confirm', invocationId };
			}
			// On approval, persist trust entry (only if not `always-confirm`, which is opt-in re-prompt).
			if (confirmDecision.reason !== 'always-confirm') {
				const next = buildTrustEntryAfterApproval(cmd, currentHash, Date.now());
				await this._upsertTrustEntry(next);
				await this._audit.append({
					ts: Date.now(),
					action: 'project_command:trust_granted',
					ok: true,
					meta: { id: cmd.id, hash: currentHash.slice(0, 8) },
				});
			}
		}

		const startedAtMs = Date.now();
		this._onDidStartCommand.fire({ id: cmd.id, name: cmd.name, invocationId, startedAtMs });

		// ── Audit log: start ───────────────────────────────────────────────────
		const auditFlags = decodeAuditFlags({
			enabled: this._config.getValue<boolean>('vibeide.audit.enable') === true
				&& this._config.getValue<boolean>('vibeide.commands.audit') === true,
			includeStdout: this._config.getValue<boolean>('vibeide.commands.auditStdout') === true,
		});
		const auditStart = redactCommandForAudit(
			{
				id: cmd.id,
				name: cmd.name,
				command: resolveResult.redactedForAudit.command,
				args: resolveResult.redactedForAudit.args,
				cwd: resolveResult.redactedForAudit.cwd,
				env: resolveResult.redactedForAudit.env,
			},
			auditFlags,
		);
		if (auditStart !== null) {
			void this._audit.append({
				ts: startedAtMs,
				action: 'project_command:start',
				ok: true,
				meta: { invocationId, ...auditStart },
			});
		}

		// Routing via decideProjectCommandLaunch (roadmap §L327).
		const os = detectLaunchOS(typeof process !== 'undefined' ? process.platform : 'unknown');
		const launchPlan = decideProjectCommandLaunch({
			command: cmd,
			os,
			isRunning: this._runningSingletonIds.has(cmd.id),
		});

		if (launchPlan.kind === 'refused') {
			const reason = launchPlan.reason;
			if (reason === 'singleton-already-running') {
				this._notification.notify({
					severity: Severity.Warning,
					message: localize('vibeide.commands.singleton.running', 'Команда «{0}» уже выполняется (singleton).', cmd.name),
				});
			}
			const endedAtMs = Date.now();
			this._onDidEndCommand.fire({ id: cmd.id, name: cmd.name, invocationId, endedAtMs, durationMs: endedAtMs - startedAtMs, outcome: 'failure' });
			return { outcome: 'refused', reason, invocationId };
		}

		if (cmd.singleton) { this._runningSingletonIds.add(cmd.id); }

		const _fireEnd = (exitCode: number | undefined, err?: string) => {
			if (cmd.singleton) { this._runningSingletonIds.delete(cmd.id); }
			const endedAtMs = Date.now();
			const outcome: DidEndCommandEvent['outcome'] = !err && exitCode === 0 ? 'success' : 'failure';
			this._onDidEndCommand.fire({ id: cmd.id, name: cmd.name, invocationId, endedAtMs, durationMs: endedAtMs - startedAtMs, outcome, exitCode });
			const auditEnd = redactCommandForAudit({
				id: cmd.id, name: cmd.name,
				command: resolveResult.redactedForAudit.command,
				args: resolveResult.redactedForAudit.args,
				cwd: resolveResult.redactedForAudit.cwd,
				env: resolveResult.redactedForAudit.env,
				exitCode, durationMs: endedAtMs - startedAtMs,
			}, auditFlags);
			if (auditEnd !== null) {
				void this._audit.append({ ts: endedAtMs, action: 'project_command:complete', ok: outcome === 'success', meta: { invocationId, outcome, ...auditEnd } });
			}
		};

		try {
			const cwdUri = this._resolveCwd(cmd.cwd);
			const fullCommand = this._buildShellLine(resolveResult.resolved.command, resolveResult.resolved.args);
			const terminalName = `Vibe: ${cmd.name}`;
			const envRecord = { ...resolveResult.resolved.env };

			if (launchPlan.kind === 'spawn-background') {
				// Background: create a quiet terminal — do not bring to front.
				const terminal = await this._terminal.createTerminal({
					cwd: cwdUri,
					location: TerminalLocation.Panel,
					config: { name: terminalName, env: envRecord },
					skipContributedProfileCheck: true,
				});
				await terminal.sendText(fullCommand, true);
				const onExitDispose = terminal.onExit((exitInfo) => {
					try {
						const exitCode = typeof exitInfo === 'object' && exitInfo !== null && Object.hasOwn(exitInfo, 'code')
							? (exitInfo as { code?: number }).code
							: typeof exitInfo === 'number' ? exitInfo : undefined;
						_fireEnd(exitCode);
					} finally { onExitDispose.dispose(); }
				});
				return { outcome: 'success', invocationId };
			}

			if (launchPlan.kind === 'spawn-external') {
				// External: wrap user command with the OS-specific launcher and send through integrated terminal.
				// The integrated terminal exits quickly once the external window is spawned.
				const externalCmd = [launchPlan.externalCommand, ...launchPlan.externalArgs, fullCommand].join(' ');
				const terminal = await this._terminal.createTerminal({
					cwd: cwdUri,
					location: TerminalLocation.Panel,
					config: { name: terminalName, env: envRecord },
					skipContributedProfileCheck: true,
				});
				await this._terminal.setActiveInstance(terminal);
				await this._terminal.focusActiveInstance();
				await terminal.sendText(externalCmd, true);
				const onExitDispose = terminal.onExit((exitInfo) => {
					try {
						const exitCode = typeof exitInfo === 'object' && exitInfo !== null && Object.hasOwn(exitInfo, 'code')
							? (exitInfo as { code?: number }).code
							: typeof exitInfo === 'number' ? exitInfo : undefined;
						_fireEnd(exitCode);
					} finally { onExitDispose.dispose(); }
				});
				return { outcome: 'success', invocationId };
			}

			// kind === 'open-integrated' (default path).
			const terminal = await this._terminal.createTerminal({
				cwd: cwdUri,
				location: TerminalLocation.Panel,
				config: { name: terminalName, forceShellIntegration: true, env: envRecord },
				skipContributedProfileCheck: true,
			});
			await this._terminal.setActiveInstance(terminal);
			await this._terminal.focusActiveInstance();
			await terminal.sendText(fullCommand, true);
			const onExitDispose = terminal.onExit((exitInfo) => {
				try {
					const exitCode = typeof exitInfo === 'object' && exitInfo !== null && Object.hasOwn(exitInfo, 'code')
						? (exitInfo as { code?: number }).code
						: typeof exitInfo === 'number' ? exitInfo : undefined;
					_fireEnd(exitCode);
				} finally { onExitDispose.dispose(); }
			});
			return { outcome: 'success', invocationId };
		} catch (e) {
			this._log.error(`[VibeCustomCommands] failed to spawn ${id}: ${(e as Error).message}`);
			_fireEnd(undefined, (e as Error).message);
			return { outcome: 'failure', reason: (e as Error).message, invocationId };
		}
	}

	/** Resolve cwd relative to the first workspace root when given a relative string. */
	private _resolveCwd(cwd: string | undefined): URI | undefined {
		if (!cwd) {
			return this._workspace.getWorkspace().folders[0]?.uri;
		}
		// Absolute path: use as-is via URI.file.
		if (/^([a-zA-Z]:[\\/]|\/)/.test(cwd)) {
			return URI.file(cwd);
		}
		// Relative: join under the first workspace folder.
		const root = this._workspace.getWorkspace().folders[0]?.uri;
		if (!root) {
			return undefined;
		}
		return joinPath(root, ...cwd.split(/[\\/]/));
	}

	/** Compose the line that gets sent to the integrated terminal. */
	private _buildShellLine(command: string, args: readonly string[]): string {
		if (!args || args.length === 0) {
			return command;
		}
		const quoted = args.map(a => this._quoteShellArg(a));
		return [command, ...quoted].join(' ');
	}

	/** Best-effort POSIX/PowerShell-friendly quoting. */
	private _quoteShellArg(arg: string): string {
		if (arg.length === 0) {
			return `''`;
		}
		if (/^[A-Za-z0-9_.@:/=+-]+$/.test(arg)) {
			return arg;
		}
		// Wrap in single quotes; escape embedded single quotes.
		return `'${arg.replace(/'/g, `'\\''`)}'`;
	}

	// ── Trust file I/O (workspace-scoped) ────────────────────────────────────
	// .vibe/commands.trust.json lives next to commands.json. Missing file is
	// treated as "no trust entries yet"; malformed file is logged + ignored so
	// the IDE doesn't refuse to spawn anything on a single corrupt write.

	private _trustUri(): URI | undefined {
		const folder = this._workspace.getWorkspace().folders[0];
		if (!folder) { return undefined; }
		return joinPath(folder.uri, ...TRUST_FILE_NAME.split('/'));
	}

	private async _readTrustEntries(): Promise<readonly CommandTrustEntry[]> {
		const uri = this._trustUri();
		if (!uri) { return []; }
		let buf;
		try {
			buf = await this._fileService.readFile(uri);
		} catch {
			return [];
		}
		// L304: tolerate JSONC + corruption — empty/invalid trust file = "no trust yet".
		const parseResult = safeParseConfigJson(buf.value.toString());
		if (!parseResult.ok) {
			if (parseResult.reason !== 'empty') {
				this._log.warn(`[VibeCustomCommands] ${TRUST_FILE_NAME} parse failed: ${parseResult.reason}`);
			}
			return [];
		}
		const decoded = decodeCommandTrustEntries(parseResult.value);
		if (decoded === null) {
			this._log.warn(`[VibeCustomCommands] ${TRUST_FILE_NAME} shape invalid; ignoring`);
			return [];
		}
		return decoded;
	}

	private async _upsertTrustEntry(entry: CommandTrustEntry): Promise<void> {
		const existing = await this._readTrustEntries();
		const next: CommandTrustEntry[] = [];
		let replaced = false;
		for (const e of existing) {
			if (e.id === entry.id) {
				next.push(entry);
				replaced = true;
			} else {
				next.push(e);
			}
		}
		if (!replaced) {
			next.push(entry);
		}
		await this._writeTrustEntries(next);
	}

	private async _writeTrustEntries(entries: readonly CommandTrustEntry[]): Promise<void> {
		const uri = this._trustUri();
		if (!uri) { return; }
		try {
			await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(entries, null, '\t') + '\n'));
		} catch (e) {
			this._log.error(`[VibeCustomCommands] failed to persist ${TRUST_FILE_NAME}: ${(e as Error).message}`);
		}
	}
}

registerSingleton(IVibeCustomCommandsService, VibeCustomCommandsService, InstantiationType.Delayed);
