/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Пуш «агенту нужно внимание» в Telegram-мост
 *
 * Мост ведёт прогоны, начатые из Telegram, и зеркалит их вопросы разрешений
 * Остановка по предохранителю, сторож зависания, ошибка провайдера и разрешение для хода, начатого в IDE,
 * видны только окну: человек у телефона узнаёт о них, когда вернётся к экрану
 *
 * Здесь решение «слать ли» и текст сообщения: слой чистый, без Telegram-API и сервисов,
 * поэтому проверяется из `test/common/`
 */

import { localize } from '../../../../../nls.js';

/** Из-за чего агенту нужен человек */
export type AttentionKind =
	/** Ход остановлен предохранителем от петли: модель повторяла одно и то же действие */
	| 'loopStopped'
	/** Ход остановлен предохранителем: слишком много неудачных вызовов инструментов подряд */
	| 'toolErrorsStopped'
	/** Сторож зависания сработал и автоповтор не помог: токенов нет, ход встал */
	| 'stalled'
	/** Ход закончился ошибкой (провайдер, лимит, состояние чата) и ждёт решения */
	| 'turnFailed'
	/** Агент ждёт разрешения на действие */
	| 'awaitingApproval'
	/** Dead man's switch приостановил агента: подтверждения не было дольше таймаута */
	| 'agentPaused';

/** Что известно о случившемся; все поля, кроме вида, подписывают сообщение */
export interface AttentionSignal {
	readonly kind: AttentionKind;
	/** Проект окна, в котором это случилось */
	readonly project?: string;
	/** Узнаваемая подпись треда: начало первого сообщения человека */
	readonly thread?: string;
	/** Причина словами сервиса: текст ошибки, причина паузы */
	readonly detail?: string;
}

/** Сколько символов причины идёт в сообщение: остальное человек прочтёт в IDE */
export const ATTENTION_DETAIL_LIMIT = 300;

/** Сколько символов первого сообщения идёт в подпись треда */
export const ATTENTION_THREAD_LABEL_LIMIT = 60;

/** Состояния ленты, после которых ход считается идущим и очередная остановка — новая */
const RUNNING_STATES: readonly string[] = ['LLM', 'tool', 'preparing'];

/** Срез состояния ленты, нужный для выбора: тип привязан к слою `browser` только структурно */
export interface AttentionStreamState {
	readonly isRunning: string | undefined;
	readonly error?: { readonly message: string; readonly recoverable?: string };
}

/**
 * Что в состоянии ленты требует человека
 *
 * Ошибка при остановленном ходе — отказ или зависание: `recoverable: 'retry'` ставят только оба сторожа зависания
 * Ожидание разрешения — отдельный вид, потому что у него другое «что сделать»
 * Идущий ход, пауза по лимиту и пустое состояние внимания не просят: пауза сама возобновится
 */
export function classifyStreamAttention(state: AttentionStreamState | undefined): { kind: AttentionKind; detail?: string } | undefined {
	if (!state) {
		return undefined;
	}
	if (state.isRunning === 'awaiting_user') {
		return { kind: 'awaitingApproval' };
	}
	if (state.isRunning === undefined && state.error) {
		return { kind: state.error.recoverable === 'retry' ? 'stalled' : 'turnFailed', detail: state.error.message };
	}
	return undefined;
}

/** Идёт ли ход: с этого момента следующая остановка снова достойна сообщения */
export function isTurnRunning(state: AttentionStreamState | undefined): boolean {
	return state?.isRunning !== undefined && RUNNING_STATES.includes(state.isRunning);
}

/**
 * Вид, о котором ход, начатый из Telegram, уже сообщает сам
 *
 * Ошибку хода присылает слежение за прогоном, вопрос разрешения — зеркало вопросов, причём оно подчиняется
 * настройке `vibeide.telegram.approvals`: «не зеркалить» — выбор человека, и пуш его не обходит
 * Остановку предохранителем слежение видит как обычный конец («готово»), поэтому её надо сказать отдельно
 */
export function isCoveredByTelegramRun(kind: AttentionKind): boolean {
	return kind === 'turnFailed' || kind === 'stalled' || kind === 'awaitingApproval';
}

/** Вход выбора получателей */
export interface AttentionRouting {
	/** Настройка `vibeide.telegram.notifyAttention` */
	readonly notifyEnabled: boolean;
	/** Мост слушает: включён, токен есть, опрос запущен */
	readonly bridgeLive: boolean;
	/** Чат, откуда начат ход, если ход начат из Telegram */
	readonly originChatId?: number;
	/** Привязанные чаты (`vibeide.telegram.allowedChatIds`) */
	readonly allowedChatIds: readonly number[];
}

/**
 * Кому слать
 *
 * Ход из Telegram — только тому чату, откуда он начат: другие привязанные чаты его не просили
 * Ход из IDE — всем привязанным: привязка и есть согласие получать сообщения об агенте
 * Пусто — слать некому или нельзя
 */
export function selectAttentionRecipients(routing: AttentionRouting): readonly number[] {
	if (!routing.notifyEnabled || !routing.bridgeLive) {
		return [];
	}
	if (routing.originChatId !== undefined) {
		return [routing.originChatId];
	}
	return [...new Set(routing.allowedChatIds)];
}

/**
 * Реестр уже посланного в пределах хода
 *
 * Лента повторяет одно и то же состояние на каждое событие, а два источника (предохранитель и ошибка, которую он
 * оставил в ленте) описывают одну остановку, поэтому ключ — «ход + класс»: остановки одного хода делят класс `stop`
 * Ход пошёл снова (`reset`) — следующая остановка новая
 */
export class AttentionLedger {

	private readonly _sent = new Map<string, Set<string>>();

	/** Занять место под сообщение: `true` — слать, `false` — об этом в ходе уже сказано */
	claim(turnKey: string, classKey: string): boolean {
		let classes = this._sent.get(turnKey);
		if (!classes) {
			classes = new Set();
			this._sent.set(turnKey, classes);
		}
		if (classes.has(classKey)) {
			return false;
		}
		classes.add(classKey);
		return true;
	}

	/** Начался новый ход: прежние остановки не мешают */
	reset(turnKey: string): void {
		this._sent.delete(turnKey);
	}

	/** Ход ушёл насовсем (тред удалён) */
	clear(): void {
		this._sent.clear();
	}
}

/**
 * Класс сообщения в реестре
 *
 * Все остановки хода делят один класс: о ходе, который встал, достаточно одного сообщения, каким бы сторожем он ни пойман
 * Разрешения различаются по вызову, на который агент ждёт ответа: новый вызов — новый вопрос
 */
export function attentionClassKey(kind: AttentionKind, callId?: string): string {
	switch (kind) {
		case 'awaitingApproval':
			return `approval:${callId ?? ''}`;
		case 'agentPaused':
			return 'paused';
		default:
			return 'stop';
	}
}

/** Подпись треда: начало первого сообщения человека, без переводов строк */
export function threadLabelOf(messages: readonly { readonly role: string; readonly displayContent?: string }[]): string | undefined {
	const first = messages.find(message => message.role === 'user' && !!message.displayContent?.trim());
	return first?.displayContent ? cut(first.displayContent, ATTENTION_THREAD_LABEL_LIMIT) : undefined;
}

function cut(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat.length <= limit) {
		return flat;
	}
	// Не рвём суррогатную пару: половинка символа ломает отправку
	let end = limit;
	const last = flat.charCodeAt(end - 1);
	if (last >= 0xD800 && last <= 0xDBFF) {
		end -= 1;
	}
	return `${flat.slice(0, end)}…`;
}

/**
 * Текст сообщения: что случилось, где, что сделать
 *
 * Простой текст без разметки: причина приходит от провайдера и может содержать что угодно
 */
export function formatAttentionMessage(signal: AttentionSignal): string {
	const lines = [localize('vibeide.telegram.attention.title', "⚠️ Агенту нужно внимание")];
	if (signal.project) {
		lines.push(localize('vibeide.telegram.attention.project', "Проект: {0}", signal.project));
	}
	if (signal.thread) {
		lines.push(localize('vibeide.telegram.attention.thread', "Тред: «{0}»", signal.thread));
	}
	lines.push(whatHappened(signal.kind));
	if (signal.detail) {
		lines.push(localize('vibeide.telegram.attention.detail', "Причина: {0}", cut(signal.detail, ATTENTION_DETAIL_LIMIT)));
	}
	lines.push(whatToDo(signal.kind));
	return lines.join('\n');
}

function whatHappened(kind: AttentionKind): string {
	switch (kind) {
		case 'loopStopped':
			return localize('vibeide.telegram.attention.loopStopped', "Что случилось: ход остановлен, агент повторял одно и то же действие");
		case 'toolErrorsStopped':
			return localize('vibeide.telegram.attention.toolErrorsStopped', "Что случилось: ход остановлен, инструменты подряд завершались ошибкой");
		case 'stalled':
			return localize('vibeide.telegram.attention.stalled', "Что случилось: ход завис, от провайдера нет токенов, автоповтор не помог");
		case 'turnFailed':
			return localize('vibeide.telegram.attention.turnFailed', "Что случилось: ход закончился ошибкой и ждёт решения");
		case 'awaitingApproval':
			return localize('vibeide.telegram.attention.awaitingApproval', "Что случилось: агент ждёт разрешения на действие");
		case 'agentPaused':
			return localize('vibeide.telegram.attention.agentPaused', "Что случилось: сторож приостановил агента, подтверждения не было дольше таймаута");
	}
}

function whatToDo(kind: AttentionKind): string {
	switch (kind) {
		case 'loopStopped':
			return localize('vibeide.telegram.attention.loopStopped.todo', "Что сделать: открыть тред, переформулировать задачу или сменить модель");
		case 'toolErrorsStopped':
			return localize('vibeide.telegram.attention.toolErrorsStopped.todo', "Что сделать: сменить модель или упростить запрос");
		case 'stalled':
			return localize('vibeide.telegram.attention.stalled.todo', "Что сделать: нажать «Повторить запрос» в треде или сменить модель");
		case 'turnFailed':
			return localize('vibeide.telegram.attention.turnFailed.todo', "Что сделать: повторить ход или сменить модель либо провайдера");
		case 'awaitingApproval':
			return localize('vibeide.telegram.attention.awaitingApproval.todo', "Что сделать: разрешить или отклонить действие в IDE");
		case 'agentPaused':
			return localize('vibeide.telegram.attention.agentPaused.todo', "Что сделать: подтвердить, чтобы агент продолжил, или отменить прогон в IDE");
	}
}
