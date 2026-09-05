/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IAuditLogService } from '../common/auditLogService.js';
import { chainRecord, chainTailOf, verifyAuditChain, AUDIT_CHAIN_ROOT } from '../common/auditChain.js';
import {
	applyEvent, blockingDependencies, canTransition, dependencyCycle, operationKeyOf, replayEvents,
	Task, TaskEvent, TaskStatus,
} from '../common/taskLedger/taskModel.js';
import { vibeLog } from '../common/vibeLog.js';

/**
 * Хранение реестра задач: append-only журнал событий, из которого состояние пересобирается.
 *
 * WHY a file of its own, next to the audit log rather than inside it: task traffic is frequent and
 * uninteresting to an auditor, while the audit log is evidence and should stay small enough to read.
 * raytsystem learned the same thing the harder way and wrote it down in their ADR-015 — mixing task
 * activity into the knowledge ledger couples invalidation and recovery to something that churns.
 *
 * WHY next to it and not in the working folder: the audit log moved out of `.vibe/` precisely
 * because an agent's own file tools reach there. A ledger the agent can quietly rewrite would record
 * whatever the agent prefers to have happened.
 */

export const IVibeTaskLedgerService = createDecorator<IVibeTaskLedgerService>('vibeTaskLedgerService');

export interface TaskCreateRequest {
	readonly title: string;
	readonly dependencyIds?: readonly string[];
	readonly actor: string;
	/**
	 * Caller's own identifier of the intent.
	 *
	 * A retry must reuse it — that is what makes the second attempt a no-op instead of a duplicate.
	 * Omitted means «this is a fresh request», and a fresh id is generated.
	 */
	readonly intent?: string;
}

export interface TaskTransitionRequest {
	readonly taskId: string;
	readonly to: TaskStatus;
	readonly actor: string;
	readonly blockedReason?: string;
	readonly intent?: string;
}

export type TaskWriteResult =
	| { readonly ok: true; readonly task: Task; readonly repeated: boolean }
	| { readonly ok: false; readonly error: string };

export interface IVibeTaskLedgerService {
	readonly _serviceBrand: undefined;
	/** Fires whenever the register changes, so a panel can redraw without polling. */
	readonly onDidChange: Event<void>;
	/** Current tasks, newest first by creation. */
	tasks(): Promise<readonly Task[]>;
	/** What a task is waiting for: dependencies that are neither done nor cancelled. */
	waitingFor(taskId: string): Promise<readonly string[]>;
	create(request: TaskCreateRequest): Promise<TaskWriteResult>;
	transition(request: TaskTransitionRequest): Promise<TaskWriteResult>;
	/** Is the journal intact — same question the audit log answers, same kind of answer. */
	verify(): Promise<{ readonly intact: boolean; readonly detail: string }>;
	/** Where the journal lives, for the diagnostics command. */
	location(): URI | undefined;
}

/** Rotation threshold. Beyond this the journal is archived and the chain restarts in a fresh file. */
const MAX_LEDGER_MB = 8;

class VibeTaskLedgerService extends Disposable implements IVibeTaskLedgerService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _path: URI | undefined;
	private _tasks: Map<string, Task> = new Map();
	/**
	 * operation key → the task it produced.
	 *
	 * A set would only say «this was already done» without saying to what. Answering a retry by
	 * searching for a task with the same title looked equivalent and is not: two tasks may share a
	 * title, and the caller would get the wrong one back.
	 */
	private _operationTasks = new Map<string, string>();
	private _chainTail = AUDIT_CHAIN_ROOT;
	private _loaded: Promise<void> | undefined;
	/** Serializes writes: two concurrent appends would interleave and break the chain. */
	private _writing: Promise<unknown> = Promise.resolve();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IAuditLogService private readonly _auditLog: IAuditLogService,
	) {
		super();
		const workspace = workspaceContextService.getWorkspace();
		// Per workspace, like the audit log: two projects must not share one register.
		this._path = workspace.folders.length > 0
			? joinPath(this._environmentService.workspaceStorageHome, workspace.id, 'tasks.jsonl')
			: joinPath(this._environmentService.workspaceStorageHome, 'tasks.jsonl');
	}

	location(): URI | undefined {
		return this._path;
	}

	async tasks(): Promise<readonly Task[]> {
		await this._ensureLoaded();
		return [...this._tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
	}

	async waitingFor(taskId: string): Promise<readonly string[]> {
		await this._ensureLoaded();
		const task = this._tasks.get(taskId);
		return task ? blockingDependencies(task, this._tasks) : [];
	}

	async create(request: TaskCreateRequest): Promise<TaskWriteResult> {
		await this._ensureLoaded();
		const dependencyIds = [...(request.dependencyIds ?? [])];
		const intent = request.intent ?? generateUuid();
		const operationKey = operationKeyOf('create', intent, { title: request.title, dependencyIds });

		const producedId = this._operationTasks.get(operationKey);
		if (producedId) {
			// The same request arriving twice is a retry, not a second task: answer with exactly what
			// the first attempt produced, so the caller cannot tell — and does not need to.
			const existing = this._tasks.get(producedId);
			return existing ? { ok: true, task: existing, repeated: true } : { ok: false, error: 'повтор операции без задачи' };
		}

		const taskId = generateUuid();
		const candidate: Task = {
			id: taskId, title: request.title, status: 'inbox', dependencyIds,
			createdBy: request.actor, createdAt: Date.now(), updatedAt: Date.now(), revision: 1,
		};
		const cycle = dependencyCycle([...this._tasks.values(), candidate]);
		if (cycle) {
			// Refused before it is written: a cycle never becomes ready, and a register full of tasks
			// that can never start is worse than a refusal a person can act on.
			return { ok: false, error: `зависимости образуют цикл: ${cycle.join(' → ')}` };
		}

		const event: TaskEvent = {
			kind: 'created', taskId, at: candidate.createdAt, actor: request.actor, operationKey, to: 'inbox',
			task: { title: request.title, dependencyIds, createdBy: request.actor },
		};
		return this._append(event, taskId);
	}

	async transition(request: TaskTransitionRequest): Promise<TaskWriteResult> {
		await this._ensureLoaded();
		const task = this._tasks.get(request.taskId);
		if (!task) {
			return { ok: false, error: `задача ${request.taskId} не найдена` };
		}
		const intent = request.intent ?? generateUuid();
		const operationKey = operationKeyOf('transition', intent, { taskId: request.taskId, to: request.to });
		if (this._operationTasks.has(operationKey)) {
			return { ok: true, task, repeated: true };
		}
		if (!canTransition(task.status, request.to)) {
			return { ok: false, error: `переход «${task.status}» → «${request.to}» не разрешён` };
		}
		if (request.to === 'running') {
			const waiting = blockingDependencies(task, this._tasks);
			if (waiting.length > 0) {
				// Starting work that waits on something is how a dependency becomes decorative.
				return { ok: false, error: `задача ждёт: ${waiting.join(', ')}` };
			}
		}

		const event: TaskEvent = {
			kind: request.to === 'cancelled' ? 'cancelled' : 'transitioned',
			taskId: request.taskId, at: Date.now(), actor: request.actor, operationKey,
			from: task.status, to: request.to, blockedReason: request.blockedReason,
		};
		return this._append(event, request.taskId);
	}

	async verify(): Promise<{ intact: boolean; detail: string }> {
		const lines = await this._readLines();
		if (lines.length === 0) {
			// Said plainly rather than dressed up as success: an empty journal proves nothing.
			return { intact: true, detail: 'журнал задач пуст — проверять нечего' };
		}
		const verdict = verifyAuditChain(lines);
		return verdict.ok
			? { intact: true, detail: `журнал цел: проверено ${verdict.checked} записей` }
			: { intact: false, detail: `журнал изменён на строке ${verdict.line} (${verdict.reason})` };
	}

	/** Append one event, then fold it in. The file is the source of truth; memory follows it. */
	private async _append(event: TaskEvent, taskId: string): Promise<TaskWriteResult> {
		const path = this._path;
		if (!path) {
			return { ok: false, error: 'нет рабочей папки для журнала задач' };
		}
		const write = this._writing.then(async () => {
			await this._rotateIfNeeded(path);
			const { line, hash } = chainRecord(event as unknown as object, this._chainTail);
			// Read-concat-write, symmetric with the audit log. A true append would be better on a large
			// file; changing that is a decision for both journals at once, not for this one alone.
			const existing = await this._fileService.readFile(path).catch(() => undefined);
			const body = existing ? existing.value.toString() : '';
			await this._fileService.writeFile(path, VSBuffer.fromString(body + line + '\n'));
			this._chainTail = hash;
			// Folded in, not recomputed: replaying the whole history on every write would make each
			// new task cost more than the last.
			const applied = applyEvent(this._tasks, event);
			this._tasks = applied.tasks;
			this._operationTasks.set(event.operationKey, event.taskId);
		});
		this._writing = write.catch(() => { });
		try {
			await write;
		} catch (err) {
			vibeLog.warn('taskLedger', `запись в журнал задач не удалась: ${err}`);
			return { ok: false, error: 'записать задачу не удалось' };
		}
		const task = this._tasks.get(taskId);
		if (!task) {
			return { ok: false, error: 'событие записано, но не применилось' };
		}
		this._onDidChange.fire();
		// Also into the audit log: the register says WHAT the work is, the audit says who moved it and
		// when. Keeping both is not duplication — one is a board, the other is evidence.
		void this._auditLog.append({
			ts: event.at,
			actor: event.actor === 'human' ? 'human' : 'agent',
			actorId: event.actor === 'human' ? undefined : event.actor,
			action: event.kind === 'created' ? 'task_created' : 'task_transitioned',
			ok: true,
			meta: { taskId: event.taskId, title: task.title, from: event.from, to: event.to, blockedReason: event.blockedReason },
		}).catch(() => { /* the register is written already; a missing audit line must not undo it */ });
		return { ok: true, task, repeated: false };
	}

	private async _rotateIfNeeded(path: URI): Promise<void> {
		const stat = await this._fileService.stat(path).catch(() => undefined);
		if (!stat?.size || stat.size < MAX_LEDGER_MB * 1024 * 1024) {
			return;
		}
		let archive: URI;
		let index = 1;
		do {
			archive = path.with({ path: path.path.replace(/\.jsonl$/, `.${index++}.jsonl`) });
		} while (await this._fileService.exists(archive));
		const content = await this._fileService.readFile(path).catch(() => undefined);
		if (content) {
			await this._fileService.writeFile(archive, content.value);
		}
		await this._fileService.writeFile(path, VSBuffer.fromString(''));
		// The chain restarts here: the archived part is verified on its own, and linking across files
		// would make a fresh journal fail from its first line.
		this._chainTail = AUDIT_CHAIN_ROOT;
		vibeLog.debug('taskLedger', `журнал задач заархивирован в ${archive.path}`);
	}

	private async _readLines(): Promise<string[]> {
		if (!this._path) {
			return [];
		}
		const content = await this._fileService.readFile(this._path).catch(() => undefined);
		return content ? content.value.toString().split('\n').filter(line => line.trim().length > 0) : [];
	}

	private async _ensureLoaded(): Promise<void> {
		if (!this._loaded) {
			this._loaded = this._load();
		}
		await this._loaded;
	}

	private async _load(): Promise<void> {
		const lines = await this._readLines();
		const events: TaskEvent[] = [];
		for (const line of lines) {
			try {
				events.push(JSON.parse(line) as TaskEvent);
			} catch {
				// A single unreadable line must not cost the whole register: it is named in the log and
				// the rest of the history still loads.
				vibeLog.warn('taskLedger', 'нечитаемая строка в журнале задач — пропущена');
			}
		}
		const result = replayEvents(events);
		this._tasks = result.tasks;
		this._operationTasks = new Map();
		for (const event of events) {
			if (result.operationKeys.has(event.operationKey) && !this._operationTasks.has(event.operationKey)) {
				this._operationTasks.set(event.operationKey, event.taskId);
			}
		}
		this._chainTail = lines.length > 0 ? chainTailOf(lines) : AUDIT_CHAIN_ROOT;
		if (result.rejected.length > 0) {
			vibeLog.warn('taskLedger', `в журнале задач ${result.rejected.length} несогласованных событий — пропущены`);
		}
		vibeLog.debug('taskLedger', `реестр задач: ${this._tasks.size} задач из ${events.length} событий`);
	}
}

registerSingleton(IVibeTaskLedgerService, VibeTaskLedgerService, InstantiationType.Delayed);
