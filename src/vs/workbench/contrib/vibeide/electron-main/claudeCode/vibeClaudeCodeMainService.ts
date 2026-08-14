/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { promises as fsPromises } from 'fs';
import { spawn } from 'child_process';
import { join } from '../../../../../base/common/path.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { vibeLog } from '../../common/vibeLog.js';
import {
	CLAUDE_AGENT_SDK_PACKAGE,
	IClaudeSdkStatus,
	parseInstalledVersion,
	sdkEntryPointPath,
	sdkInstallArgs,
} from '../../common/claudeCode/claudeCodeProvision.js';
import { renderApprovalCard, shouldAskOwner, toolPermissionOf, type ClaudeApprovalDecision, type ClaudeToolPermission } from '../../common/claudeCode/claudeCodeApproval.js';
import {
	ClaudeRunEvent,
	IClaudeRunHandle,
	IClaudeRunRequest,
	IVibeClaudeCodeMain,
} from '../../common/claudeCode/vibeClaudeCodeTypes.js';

/** Минимальная форма того, что нам нужно от `query()` — чтобы не тянуть типы отсутствующего пакета. */
interface SdkQueryFn {
	(args: { prompt: string; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>> & { interrupt?(): Promise<unknown> };
}

/** Ожидающее решение владельца: промис, который держит вызов инструмента. */
interface IPendingApproval {
	readonly runId: string;
	readonly resolve: (permission: ClaudeToolPermission) => void;
	readonly input: Record<string, unknown>;
}

interface IActiveRun {
	readonly runId: string;
	sessionId?: string;
	/** Прерывание прогона: `interrupt()` у Query, когда SDK его отдал. */
	interrupt?: () => Promise<unknown>;
	stopped: boolean;
}

/**
 * Мост «Claude Code с телефона» — main-процесс.
 *
 * SDK не входит в дистрибутив: он везёт с собой копию Claude Code, и её вес добавлялся бы к
 * каждому installer ради возможности, нужной не каждому. Ставится один раз в служебную папку,
 * подключается динамическим импортом.
 *
 * **Подтверждение ждёт бесконечно.** Так решил владелец, и это правильный выбор для сценария
 * «ушёл от компьютера»: SDK разрешает держать паузу сколько угодно, прогон стоит и ждёт касания.
 * Таймаут выглядел бы аккуратнее, но означал бы, что агент пошёл обходным путём в момент, когда
 * человек просто был за рулём. Единственное, что снимает ожидание, — остановка прогона.
 */
export class VibeClaudeCodeMainService extends Disposable implements IVibeClaudeCodeMain {

	private readonly _onEvent = this._register(new Emitter<ClaudeRunEvent>());
	readonly onEvent: Event<ClaudeRunEvent> = this._onEvent.event;

	private readonly _pending = new Map<string, IPendingApproval>();
	private readonly _runs = new Map<string, IActiveRun>();
	private _installing: Promise<IClaudeSdkStatus> | undefined;
	private _queryFn: SdkQueryFn | undefined;

	constructor(private readonly _sdkRoot: string) {
		super();
	}

	async status(): Promise<IClaudeSdkStatus> {
		if (this._installing) {
			return { state: 'installing' };
		}
		try {
			const text = await fsPromises.readFile(sdkEntryPointPath(this._sdkRoot), 'utf8');
			const version = parseInstalledVersion(text);
			return version
				? { state: 'ready', version }
				: { state: 'broken', reason: 'файл пакета не читается как манифест SDK' };
		} catch {
			return { state: 'missing' };
		}
	}

	/**
	 * Установка SDK.
	 *
	 * Идёт через `npm` пользователя, а не через свой загрузчик: у пакета есть платформенные
	 * зависимости, и повторять логику их выбора вручную значит ошибиться на первой же новой
	 * архитектуре. Параллельные вызовы разделяют один промис — иначе два окна начали бы две
	 * установки в одну папку.
	 */
	async install(): Promise<IClaudeSdkStatus> {
		if (this._installing) {
			return this._installing;
		}
		this._installing = this._install()
			.finally(() => { this._installing = undefined; });
		return this._installing;
	}

	private async _install(): Promise<IClaudeSdkStatus> {
		await fsPromises.mkdir(this._sdkRoot, { recursive: true });
		vibeLog.info('ClaudeCode', `установка ${CLAUDE_AGENT_SDK_PACKAGE} в ${this._sdkRoot}`);

		const failure = await new Promise<string | undefined>(resolve => {
			const child = spawn('npm', [...sdkInstallArgs()], { cwd: this._sdkRoot, shell: false });
			let stderr = '';
			child.stderr?.on('data', chunk => { stderr += String(chunk); });
			child.on('error', err => resolve(`npm не запустился: ${err.message}`));
			child.on('close', code => resolve(code === 0 ? undefined : `npm вернул код ${code}. ${stderr.slice(-400)}`));
		});

		if (failure) {
			vibeLog.error('ClaudeCode', `установка не удалась: ${failure}`);
			return { state: 'broken', reason: failure };
		}
		// Состояние перечитывается с диска, а не выводится из кода выхода: успешный `npm install`
		// с пустым результатом (сеть отдала мусор, диск кончился) выглядит как успех.
		return this.status();
	}

	/** Загрузка `query()` из установленного пакета. Один раз за жизнь процесса. */
	private async _loadQuery(): Promise<SdkQueryFn> {
		if (this._queryFn) {
			return this._queryFn;
		}
		const entry = join(this._sdkRoot, 'node_modules', CLAUDE_AGENT_SDK_PACKAGE, 'sdk.mjs');
		const specifier = `file://${entry}`;
		// Динамический импорт по абсолютному пути: пакет лежит вне дерева приложения, и обычный
		// резолвер его не найдёт.
		const module = await import(specifier) as { query?: SdkQueryFn };
		if (typeof module.query !== 'function') {
			throw new Error(`в ${CLAUDE_AGENT_SDK_PACKAGE} нет функции query — установка непригодна`);
		}
		this._queryFn = module.query;
		return module.query;
	}

	async start(request: IClaudeRunRequest): Promise<IClaudeRunHandle> {
		const ready = await this.status();
		if (ready.state !== 'ready') {
			throw new Error(`Claude Code SDK не готов (${ready.state}). ${ready.reason ?? ''}`.trim());
		}
		const query = await this._loadQuery();
		const runId = generateUuid();
		const run: IActiveRun = { runId, stopped: false };
		this._runs.set(runId, run);

		// Не ожидается намеренно: вызывающий получает идентификатор сразу, а ход прогона приходит
		// событиями — иначе телефон ждал бы ответа минутами, не зная, принята ли задача вообще.
		void this._drive(query, request, run);
		return { runId };
	}

	private async _drive(query: SdkQueryFn, request: IClaudeRunRequest, run: IActiveRun): Promise<void> {
		try {
			const stream = query({
				prompt: request.task,
				options: {
					cwd: request.cwd,
					...(request.resumeSessionId ? { resume: request.resumeSessionId } : {}),
					...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
					...(request.allowedTools ? { allowedTools: [...request.allowedTools] } : {}),
					...(request.disallowedTools ? { disallowedTools: [...request.disallowedTools] } : {}),
					canUseTool: (toolName: string, input: Record<string, unknown>) =>
						this._askOwner(run, toolName, input, request.mirrorReadOnly === true),
				},
			});
			run.interrupt = stream.interrupt?.bind(stream);

			let lastText = '';
			for await (const message of stream) {
				// Идентификатор сессии приходит внутри сообщений и нужен, чтобы следующая задача
				// продолжила ту же работу вместо начала с нуля.
				const sessionId = typeof message['session_id'] === 'string' ? message['session_id'] as string : undefined;
				if (sessionId) { run.sessionId = sessionId; }

				const text = this._textOf(message);
				if (text && text !== lastText) {
					lastText = text;
					this._onEvent.fire({ kind: 'text', runId: run.runId, text });
				}
				if ('result' in message && typeof message['result'] === 'string') {
					this._onEvent.fire({ kind: 'done', runId: run.runId, sessionId: run.sessionId, result: message['result'] as string });
				}
			}
			if (!run.stopped) {
				this._onEvent.fire({ kind: 'done', runId: run.runId, sessionId: run.sessionId });
			}
		} catch (err) {
			this._onEvent.fire({ kind: 'failed', runId: run.runId, error: err instanceof Error ? err.message : String(err) });
		} finally {
			this._runs.delete(run.runId);
			this._releasePendingOf(run.runId);
		}
	}

	/** Текст ассистента из сообщения SDK. Форма сообщений вендорская, поэтому читается терпимо. */
	private _textOf(message: Record<string, unknown>): string | undefined {
		const inner = message['message'];
		if (!inner || typeof inner !== 'object') { return undefined; }
		const content = (inner as { content?: unknown }).content;
		if (!Array.isArray(content)) { return undefined; }
		const parts = content
			.filter((part): part is { type: string; text: string } =>
				!!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
			.map(part => part.text.trim())
			.filter(Boolean);
		return parts.length > 0 ? parts.join('\n\n') : undefined;
	}

	/**
	 * Спросить владельца и ждать.
	 *
	 * Читающие инструменты по умолчанию не спрашиваются вовсе — иначе телефон тонет в
	 * подтверждениях `Read`, и владелец начинает жать «разрешить» не глядя, что хуже, чем не
	 * спрашивать совсем.
	 */
	private _askOwner(run: IActiveRun, toolName: string, input: Record<string, unknown>, mirrorReadOnly: boolean): Promise<ClaudeToolPermission> {
		if (!shouldAskOwner(toolName, mirrorReadOnly)) {
			return Promise.resolve(toolPermissionOf('approve', input));
		}
		const requestId = generateUuid();
		return new Promise<ClaudeToolPermission>(resolve => {
			this._pending.set(requestId, { runId: run.runId, resolve, input });
			this._onEvent.fire({
				kind: 'approval',
				approval: { requestId, runId: run.runId, toolName, card: renderApprovalCard(toolName, input) },
			});
		});
	}

	async answerApproval(requestId: string, decision: ClaudeApprovalDecision, amendText?: string): Promise<void> {
		const pending = this._pending.get(requestId);
		if (!pending) {
			// Ответ на уже снятый запрос — обычное дело: прогон могли остановить, пока владелец
			// набирал. Тишина здесь правильнее ошибки.
			return;
		}
		this._pending.delete(requestId);
		pending.resolve(toolPermissionOf(decision, pending.input, amendText));
	}

	async stop(runId: string): Promise<void> {
		const run = this._runs.get(runId);
		if (!run) { return; }
		run.stopped = true;
		this._releasePendingOf(runId);
		try {
			await run.interrupt?.();
		} catch (err) {
			vibeLog.warn('ClaudeCode', `прервать прогон не удалось: ${err}`);
		}
	}

	/**
	 * Снять зависшие запросы прогона, ОТКАЗАВ.
	 *
	 * Отпустить их разрешением было бы тем самым «тихим да», ради недопущения которого мост и
	 * задуман: владелец не ответил, значит ответа не было.
	 */
	private _releasePendingOf(runId: string): void {
		for (const [requestId, pending] of [...this._pending]) {
			if (pending.runId !== runId) { continue; }
			this._pending.delete(requestId);
			pending.resolve(toolPermissionOf('reject', pending.input));
		}
	}

	override dispose(): void {
		for (const run of [...this._runs.values()]) {
			void this.stop(run.runId);
		}
		super.dispose();
	}
}
