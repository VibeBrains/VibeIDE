/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Требования задачи — то, о чём просил человек, в его собственных словах.
 *
 * План отвечает на вопрос «как мы это сделаем» и потому меняется: шаги переставляют, дробят,
 * отбрасывают. Требования отвечают на «о чём просили» и меняться не должны — иначе проверять в
 * конце будет нечего, кроме собственного пересказа.
 *
 * ГЛАВНЫЙ ИНВАРИАНТ: требование — это ДОСЛОВНАЯ подстрока исходного текста, с точными
 * смещениями. Он и делает всю затею проверяемой: пересказ можно подогнать под сделанное, цитату
 * нельзя. Всё остальное здесь — следствия этого правила.
 */

/** Одно требование: цитата из задачи и её место в исходном тексте. */
export interface Requirement {
	/** Номер, под которым требование видно человеку: `r1`, `r2`, … */
	readonly id: string;
	/** Дословная цитата. `brief.text.slice(start, end) === quote` — проверяется тестом. */
	readonly quote: string;
	readonly start: number;
	readonly end: number;
	/**
	 * Требование снято с исполнения.
	 *
	 * Ставится ТОЛЬКО человеком и только с причиной: снятое требование — это решение отказаться от
	 * части просьбы, а такие решения принимает тот, кто просил. Агенту путь сюда закрыт, иначе
	 * слепая приёмка превратилась бы в самоаттестацию: не сделал — вычеркнул — отчитался.
	 */
	readonly waived?: { readonly by: 'user'; readonly reason: string; readonly at: number };
}

/** Разобранная задача: исходный текст целиком и требования из него. */
export interface TaskBrief {
	readonly id: string;
	/** Текст задачи ДОСЛОВНО. Хранится целиком: требования — указатели в него, а не замена ему. */
	readonly text: string;
	readonly createdAt: number;
	readonly requirements: readonly Requirement[];
}

/**
 * Потолок числа требований.
 *
 * Не экономия, а читаемость: список, который человек не может просмотреть глазами перед
 * одобрением плана, перестаёт быть договором и становится формальностью.
 */
export const MAX_REQUIREMENTS = 40;

/** Минимальная длина цитаты: «ок» и «да» требованиями не бывают. */
const MIN_QUOTE_CHARS = 12;

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * Разобрать текст задачи на пронумерованные требования.
 *
 * Разбор ДЕТЕРМИНИРОВАННЫЙ и намеренно простой — он не понимает смысла и не должен. Его работа
 * показать человеку, на какие обязательства распадается его же текст; решает человек при одобрении
 * плана. Модель, угадывающая требования, вернула бы нас к пересказу.
 *
 * Правило разбора: если в тексте есть список — требования это его пункты (так люди и пишут
 * требования). Списка нет — предложения.
 */
export function parseBrief(text: string, id: string, now: number): TaskBrief {
	const spans = hasListItems(text) ? listSpans(text) : sentenceSpans(text);
	const requirements: Requirement[] = [];
	for (const span of spans) {
		if (requirements.length >= MAX_REQUIREMENTS) { break; }
		const quote = text.slice(span.start, span.end);
		if (quote.trim().length < MIN_QUOTE_CHARS) { continue; }
		requirements.push({ id: `r${requirements.length + 1}`, quote, start: span.start, end: span.end });
	}
	return { id, text, createdAt: now, requirements };
}

const hasListItems = (text: string): boolean =>
	text.split(/\r?\n/).filter(line => LIST_MARKER.test(line)).length >= 2;

/** Пункты списка: маркер отбрасывается, но смещения считаются от начала содержимого. */
function listSpans(text: string): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	let offset = 0;
	for (const line of text.split(/\r?\n/)) {
		const marker = LIST_MARKER.exec(line);
		if (marker) {
			const start = offset + marker[0].length;
			const end = offset + trimmedEnd(line);
			if (end > start) { spans.push({ start, end }); }
		}
		offset += line.length + 1; // перевод строки
	}
	return spans;
}

/**
 * Предложения.
 *
 * Разделители — точка, вопросительный и восклицательный знаки плюс перевод строки: в задачах строка
 * часто и есть предложение без точки в конце (владелец так и пишет — «одна мысль, одна строка»).
 */
function sentenceSpans(text: string): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const isBreak = ch === '\n' || ((ch === '.' || ch === '!' || ch === '?') && isBoundary(text, i));
		if (!isBreak) { continue; }
		const end = ch === '\n' ? i : i + 1;
		pushTrimmed(spans, text, start, end);
		start = i + 1;
	}
	pushTrimmed(spans, text, start, text.length);
	return spans;
}

/** Точка внутри `.vibe`, `1.5` или `т.е.` предложение не заканчивает. */
const isBoundary = (text: string, i: number): boolean => {
	const next = text[i + 1];
	return next === undefined || next === ' ' || next === '\n' || next === '\r';
};

const trimmedEnd = (line: string): number => line.replace(/\s+$/, '').length;

function pushTrimmed(spans: { start: number; end: number }[], text: string, from: number, to: number): void {
	let start = from;
	let end = to;
	while (start < end && /\s/.test(text[start])) { start++; }
	while (end > start && /\s/.test(text[end - 1])) { end--; }
	if (end > start) { spans.push({ start, end }); }
}

/** Что покрыто, что нет — по обе стороны сразу. */
export interface BriefCoverage {
	/** Требования без единого шага: работа обещана, а делать её некому. */
	readonly uncovered: readonly Requirement[];
	/** Шаги без требования: работа, о которой не просили. */
	readonly unlinkedSteps: readonly number[];
	/** Ссылки на несуществующие требования — опечатка не должна выглядеть покрытием. */
	readonly unknownRefs: readonly string[];
	/** Снятые человеком: покрытия не требуют, но в отчёте видны. */
	readonly waived: readonly Requirement[];
}

/**
 * Двустороннее покрытие: у каждого требования шаг, у каждого шага требование.
 *
 * Обе стороны важны по-разному. Требование без шага — это невыполненное обещание. Шаг без
 * требования — это работа, о которой никто не просил, и она стоит денег и риска ровно столько же,
 * сколько заказанная.
 */
export function coverageOf(
	brief: TaskBrief,
	steps: readonly { readonly stepNumber: number; readonly requirementIds?: readonly string[]; readonly disabled?: boolean }[],
): BriefCoverage {
	const live = steps.filter(step => !step.disabled);
	const known = new Set(brief.requirements.map(r => r.id));
	const referenced = new Set<string>();
	const unknownRefs = new Set<string>();
	const unlinkedSteps: number[] = [];
	for (const step of live) {
		const ids = step.requirementIds ?? [];
		if (ids.length === 0) { unlinkedSteps.push(step.stepNumber); continue; }
		for (const id of ids) {
			if (known.has(id)) { referenced.add(id); } else { unknownRefs.add(id); }
		}
	}
	const waived = brief.requirements.filter(r => r.waived);
	const uncovered = brief.requirements.filter(r => !r.waived && !referenced.has(r.id));
	return { uncovered, unlinkedSteps, unknownRefs: [...unknownRefs], waived };
}

/** Можно ли одобрять план: всё обещанное кому-то поручено. */
export const isCovered = (coverage: BriefCoverage): boolean =>
	coverage.uncovered.length === 0 && coverage.unknownRefs.length === 0;

/**
 * Снять требование — только решением человека и только с причиной.
 *
 * Функция чистая и возвращает НОВЫЙ бриф: снятие это запись в истории задачи, а не правка на месте.
 * Пустая причина отвергается — «вычеркнуто без объяснения» через месяц неотличимо от забытого.
 */
export function waiveRequirement(brief: TaskBrief, requirementId: string, reason: string, at: number): TaskBrief | undefined {
	const trimmed = reason.trim();
	if (!trimmed) { return undefined; }
	if (!brief.requirements.some(r => r.id === requirementId && !r.waived)) { return undefined; }
	return {
		...brief,
		requirements: brief.requirements.map(r => r.id === requirementId
			? { ...r, waived: { by: 'user' as const, reason: trimmed, at } }
			: r),
	};
}
