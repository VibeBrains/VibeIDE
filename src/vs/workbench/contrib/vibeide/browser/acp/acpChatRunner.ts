/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A turn of the main chat led by an external agent
 *
 * A thread whose person chose an agent does not go through the chat's own loop: the agent runs the turn itself, with
 * its own model, its own tools and its own loop. So nothing of that loop is reused — not the prompt, not the tool
 * budget, not the guards. This runner takes the person's message to the agent's session and turns what the session
 * reports into messages of the thread, so the history, the search and the export see the conversation as any other
 *
 * The runner never imports the chat service: it works through the small port the service hands in
 */

import { localize } from '../../../../../nls.js';
import { VSBuffer, encodeBase64 } from '../../../../../base/common/buffer.js';
import { RunOnceScheduler, raceTimeout } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { ThreadStreamState, ThreadType } from '../chatThreadService.js';
import { IChatJournalService } from '../chatJournalService.js';
import { IVibeIgnoreService } from '../vibeIgnoreService.js';
import { ChatImageAttachment, ChatMessage, ChatPDFAttachment, StagingSelectionItem } from '../../common/chatThreadServiceTypes.js';
import { AcpStopReason } from '../../common/acp/acpProtocol.js';
import { DEFAULT_ACP_PERMISSION_MODE } from '../../common/acp/acpPermissionPolicy.js';
import { ACP_EMBED_MAX_CHARS_DEFAULT, ACP_EMBED_MAX_CHARS_KEY } from '../../common/acp/acpPromptContext.js';
import { mirrorAcpEntries } from '../../common/acp/acpThreadMirror.js';
import { AcpLogEntry } from '../../common/acp/acpSessionLog.js';
import { VibeAgentEntry } from '../../common/acp/vibeAgentsFile.js';
import { collectAcpEditorContext } from './acpEditorContext.js';
import { IVibeAcpRegistryService } from './vibeAcpRegistryService.js';
import { IVibeAcpSessionsService, IVibeAcpSessionView } from './vibeAcpSessionsService.js';

/** Streamed chunks arrive by the dozen a second; the thread is rewritten at most this often */
const SYNC_DELAY_MS = 60;

/** How long a stop waits for the agent to end its turn before the chat lets go of it */
const STOP_WAIT_MS = 5_000;

/** The agent leading a thread, as the thread remembers it */
export type AcpThreadBinding = NonNullable<ThreadType['acpAgent']>;

/** What the runner needs from the chat service */
export interface IAcpThreadPort {
	getThread(threadId: string): ThreadType | undefined;
	addUserMessage(threadId: string, message: {
		readonly content: string;
		readonly displayContent: string;
		readonly selections: StagingSelectionItem[];
		readonly images?: ChatImageAttachment[];
		readonly pdfs?: ChatPDFAttachment[];
	}): void;
	addMessage(threadId: string, message: ChatMessage): void;
	editMessage(threadId: string, messageIdx: number, message: ChatMessage): void;
	setStreamState(threadId: string, state: ThreadStreamState[string]): void;
	setBinding(threadId: string, binding: AcpThreadBinding): void;
}

export interface IAcpChatRequest {
	readonly threadId: string;
	readonly text: string;
	readonly displayContent: string;
	readonly selections: readonly StagingSelectionItem[];
	readonly images?: readonly ChatImageAttachment[];
	readonly pdfs?: readonly ChatPDFAttachment[];
}

/** A message already written to the thread for a block of the log */
interface IWrittenBlock {
	/** The message as the thread holds it: edits find it by reference, because trimming moves indexes */
	message: ChatMessage;
	sources: readonly AcpLogEntry[];
}

export class AcpChatRunner extends Disposable {

	/** The turn in flight, by thread */
	private readonly _turns = new Map<string, Promise<void>>();

	constructor(
		private readonly _port: IAcpThreadPort,
		@IVibeAcpSessionsService private readonly _sessions: IVibeAcpSessionsService,
		@IVibeAcpRegistryService private readonly _registry: IVibeAcpRegistryService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IEditorService private readonly _editorService: IEditorService,
		@IModelService private readonly _modelService: IModelService,
		@IFileService private readonly _fileService: IFileService,
		@IVibeIgnoreService private readonly _ignore: IVibeIgnoreService,
		@IChatJournalService private readonly _journal: IChatJournalService,
	) {
		super();
	}

	/** The message goes to the agent; resolves when its turn is over. A turn still going is stopped first, as for a model */
	async send(request: IAcpChatRequest): Promise<void> {
		const { threadId } = request;
		await this.stop(threadId);
		this._settleLeftovers(threadId);
		const content = withPdfText(request.text, request.pdfs);
		this._port.addUserMessage(threadId, {
			content,
			displayContent: request.displayContent,
			selections: [...request.selections],
			images: request.images ? [...request.images] : undefined,
			pdfs: request.pdfs ? [...request.pdfs] : undefined,
		});
		const turn = this._runTurn(request, content);
		this._turns.set(threadId, turn);
		try {
			await turn;
		} finally {
			if (this._turns.get(threadId) === turn) { this._turns.delete(threadId); }
		}
	}

	/**
	 * A call card still «in progress» when no turn runs was cut off by closing the IDE: nothing finishes it any more
	 * The session log settles the cards of its own turns; this settles the ones a restart left in the stored thread
	 */
	private _settleLeftovers(threadId: string): void {
		const messages = this._port.getThread(threadId)?.messages ?? [];
		messages.forEach((message, idx) => {
			if (message.role === 'acp_tool' && (message.status === 'pending' || message.status === 'in_progress')) {
				this._port.editMessage(threadId, idx, { ...message, status: 'cancelled' });
			}
		});
	}

	/** Asks the agent to end its turn and waits for it a little; nothing running — nothing to do */
	async stop(threadId: string): Promise<void> {
		const turn = this._turns.get(threadId);
		const view = this._viewOf(this._port.getThread(threadId)?.acpAgent?.sessionId);
		if (view?.busy) {
			await this._sessions.cancel(view.sessionId);
		}
		if (turn) {
			await raceTimeout(turn.catch(() => undefined), STOP_WAIT_MS);
		}
	}

	/** The person changed the mode: the live session of the thread takes it at once, a later one takes it when it starts */
	async applyMode(threadId: string): Promise<void> {
		const binding = this._port.getThread(threadId)?.acpAgent;
		const view = this._viewOf(binding?.sessionId);
		if (binding && view) {
			await this._sessions.setPermissionMode(view.sessionId, binding.mode ?? DEFAULT_ACP_PERMISSION_MODE);
		}
	}

	/** The chat no longer needs the agent process (the tab is closed, the thread is deleted); the thread keeps the session id to come back to */
	async release(threadId: string): Promise<void> {
		await this.stop(threadId);
		const sessionId = this._port.getThread(threadId)?.acpAgent?.sessionId;
		if (sessionId && this._viewOf(sessionId)) {
			await this._sessions.endSession(sessionId);
		}
	}

	private _viewOf(sessionId: string | undefined): IVibeAcpSessionView | undefined {
		return sessionId ? this._sessions.sessions.find(view => view.sessionId === sessionId) : undefined;
	}

	private async _runTurn(request: IAcpChatRequest, content: string): Promise<void> {
		const { threadId } = request;
		const binding = this._port.getThread(threadId)?.acpAgent;
		if (!binding) { return; }
		const fail = (message: string) => this._port.setStreamState(threadId, { isRunning: undefined, error: { message, fullError: null } });

		const agent = this._registry.agents.find(entry => entry.id === binding.agentId);
		if (!agent) {
			fail(localize('vibeide.acpChat.agentGone', "Агента «{0}» больше нет в .vibe/agents.json. Выберите другого и начните новый чат.", binding.agentName));
			return;
		}

		const interrupt = Promise.resolve(() => { void this.stop(threadId); });
		this._port.setStreamState(threadId, {
			isRunning: 'preparing',
			llmInfo: { displayContentSoFar: localize('vibeide.acpChat.starting', "Запускаю агента «{0}»…", binding.agentName), reasoningSoFar: '', toolCallSoFar: null },
			interrupt,
		});

		let sessionId: string;
		try {
			sessionId = await this._ensureSession(threadId, agent, binding);
		} catch (err) {
			fail(localize('vibeide.acpChat.startFailed', "Агент «{0}» не запустился: {1}", binding.agentName, err instanceof Error ? err.message : String(err)));
			return;
		}

		const written = new Map<string, IWrittenBlock>();
		let turnStart = 0;
		let phase: 'LLM' | 'awaiting_user' | undefined;
		const sync = () => {
			const view = this._viewOf(sessionId);
			if (!view) { return; }
			this._mirror(threadId, view.log.entries, turnStart, written);
			const next = view.pendingPermission ? 'awaiting_user' : 'LLM';
			if (next !== phase) {
				phase = next;
				this._port.setStreamState(threadId, next === 'awaiting_user'
					? { isRunning: 'awaiting_user' }
					: { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null }, interrupt });
			}
		};
		const scheduler = new RunOnceScheduler(sync, SYNC_DELAY_MS);
		const listener = this._sessions.onDidChange(() => { if (!scheduler.isScheduled()) { scheduler.schedule(); } });

		try {
			await this._sessions.setPermissionMode(sessionId, binding.mode ?? DEFAULT_ACP_PERMISSION_MODE);
			const view = this._viewOf(sessionId);
			const canEmbed = view?.promptCapabilities.embeddedContext === true;
			const context = await collectAcpEditorContext(
				{ editorService: this._editorService, modelService: this._modelService, fileService: this._fileService, ignore: this._ignore },
				request.selections,
				{ canEmbed, maxChars: this._configuration.getValue<number>(ACP_EMBED_MAX_CHARS_KEY) ?? ACP_EMBED_MAX_CHARS_DEFAULT },
			);
			const images = (request.images ?? []).map(image => ({ data: encodeBase64(VSBuffer.wrap(image.data)), mimeType: image.mimeType }));
			if (images.length > 0 && view?.promptCapabilities.image !== true) {
				this._notice(threadId, localize('vibeide.acpChat.noImages', "Агент «{0}» не принимает изображения, поэтому вложения ему не отправлены.", binding.agentName));
			}
			const prompting = this._sessions.prompt(sessionId, { text: content, images, context });
			// `prompt` marks where its turn begins before it first yields, so the mark is already there
			turnStart = this._viewOf(sessionId)?.turnStart ?? 0;
			sync();
			await prompting;
		} finally {
			listener.dispose();
			scheduler.dispose();
		}
		sync();
		this._finish(threadId, sessionId, binding);
	}

	/** The agent's session for the thread: the live one, or a returned one, or a new one */
	private async _ensureSession(threadId: string, agent: VibeAgentEntry, binding: AcpThreadBinding): Promise<string> {
		const remember = (sessionId: string) => {
			if (sessionId !== binding.sessionId) { this._port.setBinding(threadId, { ...binding, sessionId }); }
			return sessionId;
		};
		const live = this._viewOf(binding.sessionId);
		if (live && live.agentId === agent.id) {
			if (!live.disconnected) { return live.sessionId; }
			const back = await this._sessions.reconnect(live.sessionId);
			if (!back) { throw new Error(this._viewOf(live.sessionId)?.error ?? localize('vibeide.acpChat.reconnectFailed', "связь с агентом не восстановилась")); }
			return remember(back);
		}
		if (binding.sessionId) {
			const { session, mode } = await this._sessions.resumeSession(agent, binding.sessionId);
			if (mode === 'new') {
				this._notice(threadId, localize('vibeide.acpChat.forgot', "Агент «{0}» не умеет продолжать прошлую сессию: начата новая, разговор выше он не помнит.", binding.agentName));
			}
			return remember(session.sessionId);
		}
		return remember((await this._sessions.startSession(agent)).sessionId);
	}

	/** Brings the thread in line with the log of the turn: a block seen first is added, a block that grew is rewritten in place */
	private _mirror(threadId: string, entries: readonly AcpLogEntry[], turnStart: number, written: Map<string, IWrittenBlock>): void {
		for (const block of mirrorAcpEntries(entries, turnStart)) {
			const known = written.get(block.key);
			if (!known) {
				this._port.addMessage(threadId, block.message);
				const messages = this._port.getThread(threadId)?.messages ?? [];
				written.set(block.key, { message: messages[messages.length - 1], sources: block.sources });
				continue;
			}
			if (known.sources.length === block.sources.length && known.sources.every((source, i) => source === block.sources[i])) { continue; }
			const messages = this._port.getThread(threadId)?.messages ?? [];
			const idx = messages.lastIndexOf(known.message);
			// The thread dropped the old messages to stay within its cap: there is nothing left to rewrite
			if (idx === -1) { continue; }
			const createdAt = (known.message as { createdAt?: number }).createdAt;
			this._port.editMessage(threadId, idx, { ...block.message, ...(createdAt === undefined ? {} : { createdAt }) } as ChatMessage);
			known.message = this._port.getThread(threadId)?.messages[idx] ?? known.message;
			known.sources = block.sources;
		}
	}

	/** The end of a turn: the stream state, the reason it ended when it is not an ordinary end, and what it cost */
	private _finish(threadId: string, sessionId: string, binding: AcpThreadBinding): void {
		const view = this._viewOf(sessionId);
		if (!view) {
			this._port.setStreamState(threadId, undefined);
			return;
		}
		if (view.error) {
			// A dead process comes back by itself with the next message: there is no separate button for it any more
			const message = view.disconnected ? `${view.error}\n${localize('vibeide.acpChat.reconnectHint', "Отправьте сообщение ещё раз: агент переподключится и продолжит разговор.")}` : view.error;
			this._port.setStreamState(threadId, { isRunning: undefined, error: { message, fullError: null } });
		} else {
			this._port.setStreamState(threadId, undefined);
			const reason = view.lastStopReason ? stopReasonNotice(view.lastStopReason, binding.agentName) : undefined;
			if (reason) { this._notice(threadId, reason); }
		}
		const spend = view.log.spend;
		if (spend) {
			this._journal.append({
				category: 'agents',
				level: 'info',
				text: localize('vibeide.acpChat.spend', "Агент «{0}»: {1} из {2} токенов контекста{3}. Расход идёт по подписке агента, а не по ключам IDE.",
					binding.agentName, spend.used.toLocaleString('ru-RU'), spend.size.toLocaleString('ru-RU'), spend.costUsd === undefined ? '' : ` · $${spend.costUsd.toFixed(4)}`),
			});
		}
	}

	/** A line of the IDE in the thread, not a word of the agent */
	private _notice(threadId: string, text: string): void {
		this._port.addMessage(threadId, { role: 'assistant', displayContent: text, reasoning: '', anthropicReasoning: null, notice: true });
	}
}

/** The text of the PDFs the person attached goes after the message, as it does for the chat's own models */
function withPdfText(text: string, pdfs: readonly ChatPDFAttachment[] | undefined): string {
	const parts = (pdfs ?? [])
		.filter(pdf => pdf.extractedText && pdf.extractedText.trim().length > 0)
		.map(pdf => `[PDF: ${pdf.filename}]\n${pdf.extractedText}`);
	return parts.length > 0 ? `${text}\n\n${parts.join('\n\n')}` : text;
}

/** Why a turn ended, when the person should be told; an ordinary end and a stop they asked for need no line */
function stopReasonNotice(reason: AcpStopReason, agentName: string): string | undefined {
	switch (reason) {
		case 'completed':
		case 'cancelled':
			return undefined;
		case 'refusal':
			return localize('vibeide.acpChat.stop.refusal', "Агент «{0}» отказался выполнять задачу.", agentName);
		case 'max_turns':
			return localize('vibeide.acpChat.stop.maxTurns', "Агент «{0}» упёрся в предел шагов.", agentName);
		case 'max_tokens':
			return localize('vibeide.acpChat.stop.maxTokens', "Агент «{0}» упёрся в предел токенов.", agentName);
		case 'unknown':
			return localize('vibeide.acpChat.stop.unknown', "Агент «{0}» остановился, не назвав причину.", agentName);
	}
}
