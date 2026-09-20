/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Requirement, TaskBrief } from './taskBrief.js';

/**
 * Слепая приёмка: сверить сделанное с тем, о чём просили, — и больше ни с чем.
 *
 * ПОЧЕМУ «СЛЕПАЯ». Обычная самопроверка агента сверяет результат с планом, а план писал он сам.
 * Получается замкнутый круг: работа признаётся сделанной, потому что совпала с собственным
 * представлением о ней. Единственный внешний якорь — исходный текст человека, и приёмка обязана
 * видеть только его.
 *
 * ИЗОЛЯЦИЯ ЗДЕСЬ СТРУКТУРНАЯ, А НЕ ОБЕЩАННАЯ. `buildAcceptanceGoal` не принимает ни плана, ни
 * шагов, ни спеки — их неоткуда взять, а значит неоткуда и утечь. Обещание «приёмщик не смотрит в
 * план» держалось бы ровно до первой правки, добавившей «для контекста» ещё один аргумент.
 */

/** Чем кончилась проверка одного требования. */
export type RequirementVerdict = 'met' | 'unmet' | 'unverifiable';

export interface AcceptanceLine {
	readonly id: string;
	readonly verdict: RequirementVerdict;
	/** Чем приёмщик это обосновал: файл, строка, наблюдение. */
	readonly note: string;
}

/**
 * Задание приёмщику.
 *
 * @param brief Задача в словах человека — единственный источник истины о том, что требовалось
 * @param changedFiles Что изменилось в проекте: только пути, без диффов и объяснений
 */
export function buildAcceptanceGoal(brief: TaskBrief, changedFiles: readonly string[]): string {
	const live = brief.requirements.filter(r => !r.waived);
	const lines: string[] = [
		'Ты принимаешь работу. Тебе НЕ показывают ни план, ни спецификацию, ни переписку — только',
		'исходный текст задачи и список изменённых файлов. Это сделано намеренно: проверять надо то,',
		'о чём просил человек, а не то, что исполнитель считал нужным сделать.',
		'',
		'ТЕКСТ ЗАДАЧИ (дословно):',
		'---',
		brief.text.trim(),
		'---',
		'',
		'ТРЕБОВАНИЯ, каждое — цитата из текста выше:',
	];
	for (const requirement of live) {
		lines.push(`${requirement.id}. ${requirement.quote}`);
	}
	if (live.length === 0) {
		lines.push('(ни одного — тогда проверяй текст задачи целиком)');
	}
	const waived = brief.requirements.filter(r => r.waived);
	if (waived.length > 0) {
		// Снятые называются, чтобы приёмщик не искал их следов и не записал в невыполненные.
		lines.push('', 'СНЯТЫ ЧЕЛОВЕКОМ (проверять не нужно): ' + waived.map(r => r.id).join(', '));
	}
	lines.push(
		'',
		changedFiles.length > 0
			? `ИЗМЕНЁННЫЕ ФАЙЛЫ:\n${changedFiles.map(file => `- ${file}`).join('\n')}`
			: 'ИЗМЕНЁННЫХ ФАЙЛОВ НЕТ — это само по себе ответ на вопрос, сделана ли работа.',
		'',
		'Прочитай, что в этих файлах на самом деле сделано, и ответь по КАЖДОМУ требованию строкой:',
		'<id> | met | unmet | unverifiable | чем обосновано (файл и место)',
		'',
		'Правила вердикта:',
		'- met — ты увидел в коде именно то, о чём просили; назови файл',
		'- unmet — не нашёл, или сделано другое',
		'- unverifiable — по коду этого не проверить (например, просили посмотреть и рассказать)',
		'Не чини и не дополняй работу: твоя задача — сказать правду о ней, а не улучшить её.',
	);
	return lines.join('\n');
}

const LINE_RE = /^\s*(\S+?)\s*\|\s*(met|unmet|unverifiable)\s*\|\s*(.*)$/i;

/**
 * Разобрать ответ приёмщика.
 *
 * Требование, о котором приёмщик не сказал ничего, считается НЕПРОВЕРЕННЫМ, а не выполненным:
 * молчание — это отсутствие ответа, и подставлять на его место согласие значит врать в ту сторону,
 * которая никого не спасает.
 */
export function parseAcceptance(answer: string, requirements: readonly Requirement[]): AcceptanceLine[] {
	const byId = new Map<string, AcceptanceLine>();
	for (const raw of answer.split(/\r?\n/)) {
		const match = LINE_RE.exec(raw);
		if (!match) { continue; }
		const [, id, verdict, note] = match;
		byId.set(id, { id, verdict: verdict.toLowerCase() as RequirementVerdict, note: note.trim() });
	}
	return requirements
		.filter(requirement => !requirement.waived)
		.map(requirement => byId.get(requirement.id)
			?? { id: requirement.id, verdict: 'unverifiable' as const, note: 'приёмщик не сказал об этом требовании ничего' });
}

/** Короткая сводка для человека: что принято, что нет. */
export function summarizeAcceptance(lines: readonly AcceptanceLine[]): string {
	const met = lines.filter(l => l.verdict === 'met').length;
	const unmet = lines.filter(l => l.verdict === 'unmet').length;
	const unknown = lines.length - met - unmet;
	const parts = [`выполнено ${met} из ${lines.length}`];
	if (unmet > 0) { parts.push(`не выполнено ${unmet}`); }
	if (unknown > 0) { parts.push(`не проверить ${unknown}`); }
	return parts.join(' · ');
}
