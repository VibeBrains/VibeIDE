/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { promises as fsPromises } from 'fs';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { vibeLog } from '../../common/vibeLog.js';
import {
	ACP_AGENT_METHOD,
	ACP_CLIENT_METHOD,
	AcpStreamDecoder,
	AcpStopReason,
	JSON_RPC_ERROR,
	JsonValue,
	encodeMessage,
	errorFrame,
	initializeParams,
	isNotification,
	isRequest,
	isResponse,
	newSessionParams,
	promptParams,
	requestFrame,
	resultFrame,
	stopReasonOf,
	textOfSessionUpdate,
} from '../../common/acp/acpProtocol.js';
import { AcpEvent, IAcpAgentLaunch, IAcpSession, IVibeAcpMain } from '../../common/acp/acpTypes.js';

interface IPendingCall {
	readonly resolve: (result: JsonValue) => void;
	readonly reject: (error: Error) => void;
}

interface IAgentProcess {
	readonly launch: IAcpAgentLaunch;
	readonly child: ChildProcessWithoutNullStreams;
	readonly decoder: AcpStreamDecoder;
	readonly pending: Map<number, IPendingCall>;
	sessionId?: string;
	nextId: number;
}

/**
 * Хост ACP: VibeIDE как клиент, внешний агент как процесс.
 *
 * Зачем это поверх уже готового моста к Claude Code через его SDK. Там агент правит файлы САМ,
 * мимо IDE: его работу не видят ни подтверждения, ни журнал, ни снимок рабочей папки. Здесь всё
 * наоборот — файл читается и пишется запросом к нам (`fs/read_text_file`, `fs/write_text_file`),
 * а перед действием агент спрашивает разрешение (`session/request_permission`), и вопрос уходит
 * человеку. Агент перестаёт быть соседом по папке и становится гостем редактора.
 *
 * Процесс живёт в main по той же причине, что поллер Telegram: он один на приложение.
 */
export class VibeAcpMainService extends Disposable implements IVibeAcpMain {

	private readonly _onEvent = this._register(new Emitter<AcpEvent>());
	readonly onEvent: Event<AcpEvent> = this._onEvent.event;

	/** Агенты по идентификатору сессии. */
	private readonly _agents = new Map<string, IAgentProcess>();
	/** Запросы разрешения, ждущие ответа человека: наш id → чем ответить агенту. */
	private readonly _permissions = new Map<string, { readonly agent: IAgentProcess; readonly rpcId: number | string }>();

	async startSession(launch: IAcpAgentLaunch): Promise<IAcpSession> {
		const child = spawn(launch.command, [...launch.args], {
			cwd: launch.cwd,
			env: { ...process.env, ...(launch.env ?? {}) },
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: false,
		}) as ChildProcessWithoutNullStreams;

		const agent: IAgentProcess = { launch, child, decoder: new AcpStreamDecoder(), pending: new Map(), nextId: 1 };
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', chunk => this._onStdout(agent, String(chunk)));
		// stderr агента — не протокол, а его собственные жалобы. В лог, но не в разбор: смешать
		// их с потоком сообщений значит поломать связь из-за чужого предупреждения.
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', chunk => vibeLog.debug('ACP', `${launch.name}: ${String(chunk).trim()}`));
		child.on('error', err => this._fail(agent, `процесс не запустился: ${err.message}`));
		child.on('exit', code => this._fail(agent, `процесс агента завершился с кодом ${code}`));

		await this._call(agent, ACP_AGENT_METHOD.initialize, initializeParams());
		const created = await this._call(agent, ACP_AGENT_METHOD.newSession, newSessionParams(launch.cwd));
		const sessionId = readString(created, 'sessionId');
		if (!sessionId) {
			child.kill();
			throw new Error(`${launch.name} не вернул идентификатор сессии`);
		}
		agent.sessionId = sessionId;
		this._agents.set(sessionId, agent);
		vibeLog.info('ACP', `${launch.name}: сессия ${sessionId} в ${launch.cwd}`);
		return { sessionId, agentName: launch.name };
	}

	async prompt(sessionId: string, text: string): Promise<AcpStopReason> {
		const agent = this._require(sessionId);
		const result = await this._call(agent, ACP_AGENT_METHOD.prompt, promptParams(sessionId, text));
		const stopReason = stopReasonOf(readValue(result, 'stopReason'));
		this._onEvent.fire({ kind: 'done', sessionId, stopReason });
		return stopReason;
	}

	async answerPermission(requestId: string, optionId: string | undefined): Promise<void> {
		const pending = this._permissions.get(requestId);
		if (!pending) { return; }
		this._permissions.delete(requestId);
		// Отказ выражается отменой, а не «выбран вариант отказа»: варианты придумывает агент, и
		// угадывать, который из них означает «нет», нельзя.
		const outcome: JsonValue = optionId
			? { outcome: 'selected', optionId }
			: { outcome: 'cancelled' };
		this._send(pending.agent, resultFrame(pending.rpcId, { outcome }));
	}

	async cancel(sessionId: string): Promise<void> {
		const agent = this._agents.get(sessionId);
		if (!agent) { return; }
		// Отмена — уведомление, ответа на неё нет: агент прекращает ход и сам сообщит причину
		// остановки в ответе на текущий prompt.
		this._send(agent, { jsonrpc: '2.0', method: ACP_AGENT_METHOD.cancel, params: { sessionId } });
	}

	async endSession(sessionId: string): Promise<void> {
		const agent = this._agents.get(sessionId);
		if (!agent) { return; }
		this._agents.delete(sessionId);
		this._releasePermissionsOf(agent);
		agent.child.kill();
	}

	// ── Приём ────────────────────────────────────────────────────────────────

	private _onStdout(agent: IAgentProcess, chunk: string): void {
		const { messages, garbage } = agent.decoder.push(chunk);
		for (const line of garbage) {
			vibeLog.debug('ACP', `${agent.launch.name} напечатал не протокол: ${line.slice(0, 200)}`);
		}
		for (const message of messages) {
			if (isResponse(message)) {
				const pending = agent.pending.get(message.id as number);
				if (!pending) { continue; }
				agent.pending.delete(message.id as number);
				if (message.error) {
					pending.reject(new Error(`${message.error.message} (код ${message.error.code})`));
				} else {
					pending.resolve(message.result ?? null);
				}
				continue;
			}
			if (isRequest(message)) {
				void this._serve(agent, message.id, message.method, message.params);
				continue;
			}
			if (isNotification(message) && message.method === ACP_CLIENT_METHOD.sessionUpdate) {
				const text = textOfSessionUpdate(message.params);
				if (text && agent.sessionId) {
					this._onEvent.fire({ kind: 'text', sessionId: agent.sessionId, text });
				}
			}
		}
	}

	/**
	 * Обслуживание запроса агента — то, ради чего протокол и заводился.
	 *
	 * Чтение и запись идут через нас, а не мимо: файл, который агент собирается изменить, проходит
	 * через IDE, и та знает о правке. Незнакомый метод получает честный отказ `methodNotFound`,
	 * а не молчание: агент, не дождавшийся ответа, зависает навсегда.
	 */
	private async _serve(agent: IAgentProcess, id: number | string, method: string, params: JsonValue | undefined): Promise<void> {
		try {
			if (method === ACP_CLIENT_METHOD.readTextFile) {
				const path = readString(params, 'path');
				if (!path) { throw new Error('в запросе нет пути'); }
				const content = await fsPromises.readFile(path, 'utf8');
				this._send(agent, resultFrame(id, { content }));
				return;
			}
			if (method === ACP_CLIENT_METHOD.writeTextFile) {
				const path = readString(params, 'path');
				const content = readString(params, 'content');
				if (!path) { throw new Error('в запросе нет пути'); }
				await fsPromises.writeFile(path, content ?? '', 'utf8');
				if (agent.sessionId) {
					this._onEvent.fire({ kind: 'wrote', sessionId: agent.sessionId, path });
				}
				this._send(agent, resultFrame(id, {}));
				return;
			}
			if (method === ACP_CLIENT_METHOD.requestPermission) {
				this._askHuman(agent, id, params);
				return;
			}
			this._send(agent, errorFrame(id, JSON_RPC_ERROR.methodNotFound, `метод ${method} не поддерживается`));
		} catch (err) {
			this._send(agent, errorFrame(id, JSON_RPC_ERROR.internal, err instanceof Error ? err.message : String(err)));
		}
	}

	/**
	 * Запрос разрешения уходит человеку и ЖДЁТ.
	 *
	 * Ответ агенту не отправляется до решения: пока человек молчит, ход стоит. Автоматический
	 * отказ по времени означал бы, что агент пошёл другим путём, пока владелец отвлёкся.
	 */
	private _askHuman(agent: IAgentProcess, rpcId: number | string, params: JsonValue | undefined): void {
		const requestId = generateUuid();
		this._permissions.set(requestId, { agent, rpcId });
		const toolCall = readObject(params, 'toolCall');
		const rawOptions = readValue(params, 'options');
		const options = Array.isArray(rawOptions)
			? rawOptions
				.map(option => ({
					optionId: readString(option, 'optionId') ?? '',
					name: readString(option, 'name') ?? '',
					kind: readString(option, 'kind') ?? '',
				}))
				.filter(option => option.optionId)
			: [];
		this._onEvent.fire({
			kind: 'permission',
			request: {
				requestId,
				sessionId: agent.sessionId ?? '',
				title: readString(toolCall, 'title') ?? readString(toolCall, 'kind') ?? 'действие',
				detail: describeToolCall(toolCall),
				options,
			},
		});
	}

	// ── Отправка ─────────────────────────────────────────────────────────────

	private _call(agent: IAgentProcess, method: string, params: JsonValue): Promise<JsonValue> {
		const id = agent.nextId++;
		return new Promise<JsonValue>((resolve, reject) => {
			agent.pending.set(id, { resolve, reject });
			this._send(agent, requestFrame(id, method, params));
		});
	}

	private _send(agent: IAgentProcess, message: Parameters<typeof encodeMessage>[0]): void {
		try {
			agent.child.stdin.write(encodeMessage(message));
		} catch (err) {
			this._fail(agent, `не удалось написать агенту: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _require(sessionId: string): IAgentProcess {
		const agent = this._agents.get(sessionId);
		if (!agent) { throw new Error(`сессия ${sessionId} не найдена`); }
		return agent;
	}

	/** Оборвалась связь: незавершённые вызовы отклоняются, иначе они висят вечно. */
	private _fail(agent: IAgentProcess, reason: string): void {
		for (const [, pending] of agent.pending) {
			pending.reject(new Error(reason));
		}
		agent.pending.clear();
		this._releasePermissionsOf(agent);
		if (agent.sessionId) { this._agents.delete(agent.sessionId); }
		this._onEvent.fire({ kind: 'failed', sessionId: agent.sessionId, error: reason });
	}

	/** Запросы разрешения умершего агента снимаются: отвечать уже некому. */
	private _releasePermissionsOf(agent: IAgentProcess): void {
		for (const [requestId, pending] of [...this._permissions]) {
			if (pending.agent === agent) { this._permissions.delete(requestId); }
		}
	}

	override dispose(): void {
		for (const sessionId of [...this._agents.keys()]) {
			void this.endSession(sessionId);
		}
		super.dispose();
	}
}

// ── Чтение чужого JSON: терпимо, без исключений на форме ──────────────────────

const readValue = (source: JsonValue | undefined, key: string): JsonValue | undefined =>
	source && typeof source === 'object' && !Array.isArray(source) ? (source as Record<string, JsonValue>)[key] : undefined;

const readString = (source: JsonValue | undefined, key: string): string | undefined => {
	const value = readValue(source, key);
	return typeof value === 'string' && value ? value : undefined;
};

const readObject = (source: JsonValue | undefined, key: string): JsonValue | undefined => {
	const value = readValue(source, key);
	return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
};

/**
 * Человеческое описание того, что агент собирается сделать.
 *
 * Показывать сырой JSON нельзя: решение принимается за секунды. Поля берутся те, что спецификация
 * называет для вызова инструмента, а незнакомая форма честно сворачивается в усечённый дамп —
 * потерять поле, ради которого человек и смотрит, хуже, чем показать лишнее.
 */
export function describeToolCall(toolCall: JsonValue | undefined): string {
	const title = readString(toolCall, 'title');
	const kind = readString(toolCall, 'kind');
	const locations = readValue(toolCall, 'locations');
	const paths = Array.isArray(locations)
		? locations.map(location => readString(location, 'path')).filter(Boolean).slice(0, 5)
		: [];
	const head = [kind, title].filter(Boolean).join(': ');
	if (paths.length > 0) {
		return `${head || 'действие'}\n${paths.join('\n')}`;
	}
	if (head) { return head; }
	try {
		return JSON.stringify(toolCall ?? {}).slice(0, 300);
	} catch {
		return 'действие без описания';
	}
}
