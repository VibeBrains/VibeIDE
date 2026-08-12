/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Пошаговый трейс хода агента: план → запрос к модели → вызов инструмента → проверка → правка.
 *
 * **Почему отдельный слой, а не расширение `llmSendTrace`** (роадмап требовал сверить форму перед
 * началом). Тот буфер живёт на уровне модуля в **main-процессе**, потому что там идёт отправка, и
 * читается рендерером по IPC; его события описывают транспорт ОДНОГО запроса (`ipc-send`,
 * `first-chunk`, `dispatcher-reset`) и коррелируются по `requestId`. Шаги хода происходят в
 * рендерере, в оркестрации `chatThreadService`, и коррелируются по треду. Записывать их в чужой
 * процесс пришлось бы через IPC ради журнала, а смешение двух осей корреляции в одном кольце
 * сделало бы бесполезными обе. Общими взяты форма (кольцо фиксированной ёмкости) и главное
 * правило: **в трейс не попадает содержимое** — ни промпт, ни ответ модели, ни аргументы
 * инструментов. Только имена, счётчики, длительности и усечённые тексты ошибок.
 *
 * Зачем вообще: объёмный агентный ход не разбирается по обычным логам. Вопрос «почему агент пошёл
 * не туда» — это вопрос о ПОСЛЕДОВАТЕЛЬНОСТИ решений: сколько было хопов, где ретраи, что вернул
 * инструмент, когда сработал авто-нудж. Ответ на него должен собираться сам, а не восстанавливаться
 * по памяти постфактум.
 *
 * Чистый модуль: ни сервисов, ни времени по умолчанию нельзя — `atMs` инъецируется, поэтому
 * проверяется из `test/common/`.
 */

export type AgentTurnStepKind =
	| 'turn-start'     // пользовательское сообщение принято, ход начался
	| 'llm-request'    // отправлен запрос к модели (хоп цикла)
	| 'llm-final'      // модель ответила
	| 'llm-retry'      // повтор запроса после ошибки/пустого ответа
	| 'tool-call'      // агент вызвал инструмент
	| 'tool-result'    // инструмент вернул результат
	| 'tool-error'     // инструмент упал или был отклонён
	| 'nudge'          // авто-продолжение (ход кончился без вызова инструмента)
	| 'verify'         // отработал verify-гейт
	| 'turn-end';      // ход завершён или прерван

export interface AgentTurnStep {
	readonly atMs: number;
	readonly threadId: string;
	/** Порядковый номер шага внутри треда — то, по чему шаги читаются как последовательность. */
	readonly seq: number;
	readonly kind: AgentTurnStepKind;
	/** Имя инструмента / модели / команды — то, ЧТО делали, без того, с чем. */
	readonly name?: string;
	readonly durationMs?: number;
	/** Оценка или факт по токенам, если он в этот момент известен. */
	readonly tokens?: number;
	readonly ok?: boolean;
	/** Короткая пометка: код ошибки, причина остановки. Усечённая, без содержимого. */
	readonly detail?: string;
}

/** Ёмкость кольца: несколько ходов целиком, но не бесконечный рост в долгой сессии. */
export const AGENT_TURN_TRACE_CAPACITY = 400;

/** Длина пометки. Всё, что длиннее, — это уже содержимое, а его здесь быть не должно. */
export const AGENT_TURN_DETAIL_MAX_CHARS = 200;

const _steps: AgentTurnStep[] = [];
const _seqByThread = new Map<string, number>();

/**
 * Записывает шаг. `atMs` инъецируется ради тестов.
 *
 * Нумерация ведётся ПО ТРЕДУ, а не по кольцу: два треда идут параллельно (роль-субагент рядом с
 * основным), и сквозной счётчик превратил бы обе последовательности в чересполосицу.
 */
export function traceAgentStep(step: Omit<AgentTurnStep, 'atMs' | 'seq'>, atMs: number = Date.now()): void {
	const seq = (_seqByThread.get(step.threadId) ?? 0) + 1;
	_seqByThread.set(step.threadId, seq);
	_steps.push({
		...step,
		seq,
		atMs,
		detail: step.detail === undefined ? undefined : step.detail.slice(0, AGENT_TURN_DETAIL_MAX_CHARS),
	});
	if (_steps.length > AGENT_TURN_TRACE_CAPACITY) {
		_steps.splice(0, _steps.length - AGENT_TURN_TRACE_CAPACITY);
	}
}

/** Снимок трейса; при указанном `threadId` — только его шаги, в порядке возникновения. */
export function getAgentTurnTrace(threadId?: string): readonly AgentTurnStep[] {
	return threadId === undefined ? [..._steps] : _steps.filter(s => s.threadId === threadId);
}

export function clearAgentTurnTrace(): void {
	_steps.length = 0;
	_seqByThread.clear();
}

/**
 * Человекочитаемый разбор трейса треда.
 *
 * Не просто список: сводка сверху отвечает на вопросы, ради которых трейс и открывают — сколько
 * было хопов, сколько ретраев, какие инструменты падали. Список без неё требует считать глазами.
 */
export function formatAgentTurnTrace(threadId: string, steps: readonly AgentTurnStep[]): string {
	const mine = steps.filter(s => s.threadId === threadId);
	if (mine.length === 0) {
		return 'Трейс пуст: в этом треде ещё не было шагов (или их вытеснило кольцо).';
	}
	const count = (kind: AgentTurnStepKind) => mine.filter(s => s.kind === kind).length;
	const failedTools = mine.filter(s => s.kind === 'tool-error').map(s => s.name ?? '?');
	const spanMs = mine[mine.length - 1].atMs - mine[0].atMs;

	const header = [
		`Шагов: ${mine.length}, длительность: ${(spanMs / 1000).toFixed(1)} с`,
		`Запросов к модели: ${count('llm-request')} (повторов: ${count('llm-retry')}), авто-продолжений: ${count('nudge')}`,
		`Вызовов инструментов: ${count('tool-call')}, из них с ошибкой: ${count('tool-error')}${failedTools.length ? ` (${[...new Set(failedTools)].join(', ')})` : ''}`,
	];

	const start = mine[0].atMs;
	const rows = mine.map(s => {
		const parts = [`+${((s.atMs - start) / 1000).toFixed(1)}с`, `#${s.seq}`, s.kind];
		if (s.name) { parts.push(s.name); }
		if (s.durationMs !== undefined) { parts.push(`${(s.durationMs / 1000).toFixed(1)}с`); }
		if (s.tokens !== undefined) { parts.push(`${s.tokens}т`); }
		if (s.ok === false) { parts.push('ОШИБКА'); }
		if (s.detail) { parts.push(s.detail); }
		return parts.join(' · ');
	});

	return [...header, '', ...rows].join('\n');
}
