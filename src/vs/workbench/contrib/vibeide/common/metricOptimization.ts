/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * «Стало ли лучше?» — измерением, а не на глаз.
 *
 * VERIFY-GATE отвечает одним битом: сборка зелёная или нет. Для задач вида «ускорь эту функцию»,
 * «урежь бандл», «подними покрытие» этого мало: там нет порога «правильно», там есть число,
 * которое надо двигать. Сейчас такие задачи агент ведёт на глаз — «кажется, стало быстрее».
 *
 * Модуль даёт цикл, подсмотренный у karpathy/autoresearch: правка → замер → сравнение с базой →
 * оставить или откатить. Оттуда же взяты два ограничения, без которых цикл нечестен:
 *
 *  1. **Фиксированный бюджет на попытку.** Иначе выигрыш приходит от более долгого прогона,
 *     а не от лучшего решения, и попытки перестают быть сравнимыми.
 *  2. **Измеритель закрыт от правок.** Агент, которому мешает замер, может «улучшить» метрику,
 *     сломав сам замер. Там это решено тем, что агент трогает единственный файл; у нас — тем,
 *     что путь замера уходит в `deny_write` на время прогона.
 *
 * Число из вывода достаётся ПО КОНТРАКТУ, а не догадкой: либо именованное поле JSON, либо число
 * последней строкой. Угадывать метрику в произвольном тексте — это тот же грех, что оценивать
 * KV-кэш «долей от веса»: правдоподобно и неверно.
 */

/** Куда двигать метрику. Секунды и байты вниз, покрытие и пропускная способность вверх. */
export const enum MetricDirection {
	Lower = 'lower',
	Higher = 'higher',
}

/** Как достать число из вывода команды замера. */
export type MetricContract =
	/** Последняя строка вывода — само число (возможно, с единицами: `12.4ms`). */
	| { readonly kind: 'lastLine' }
	/** Вывод — JSON; берётся поле по точечному пути (`results.mean` или просто `bpb`). */
	| { readonly kind: 'jsonField'; readonly path: string };

export interface IMeasurementInput {
	readonly stdout: string;
	readonly contract: MetricContract;
}

export type MeasurementResult =
	| { readonly ok: true; readonly value: number }
	| { readonly ok: false; readonly reason: string };

/**
 * Достаёт метрику из вывода замера.
 *
 * Ошибка здесь — обычный исход, а не сбой: замер мог упасть, напечатать не то или смолчать.
 * Возвращается причина, потому что «не смогли прочитать» и «стало хуже» требуют от агента
 * разного, а неразличённые они превращаются в откат правильной правки.
 */
export function readMeasurement({ stdout, contract }: IMeasurementInput): MeasurementResult {
	const text = (stdout ?? '').trim();
	if (!text) {
		return { ok: false, reason: localize('vibeide.metric.emptyOutput', "Команда замера ничего не вывела.") };
	}

	if (contract.kind === 'jsonField') {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { ok: false, reason: localize('vibeide.metric.notJson', "Ожидался JSON, а вывод им не является.") };
		}
		let cursor: unknown = parsed;
		for (const segment of contract.path.split('.')) {
			if (cursor === null || typeof cursor !== 'object' || !(segment in (cursor as object))) {
				return { ok: false, reason: localize('vibeide.metric.noField', "В выводе нет поля «{0}».", contract.path) };
			}
			cursor = (cursor as Record<string, unknown>)[segment];
		}
		return typeof cursor === 'number' && Number.isFinite(cursor)
			? { ok: true, value: cursor }
			: { ok: false, reason: localize('vibeide.metric.fieldNotNumber', "Поле «{0}» не является числом.", contract.path) };
	}

	const lastLine = text.split(/\r?\n/).filter(line => line.trim()).pop() ?? '';
	// Единицы после числа допускаются — бенчмарки печатают «12.4ms» чаще, чем голое число.
	// Разделитель тысяч не поддерживаем намеренно: «1,234» неоднозначно (у половины мира это
	// дробь), а молча выбранное толкование даст ошибку в тысячу раз.
	const match = /^([+-]?\d+(?:\.\d+)?)\s*[a-zA-Zа-яА-Я%/]*$/.exec(lastLine.trim());
	if (!match) {
		return {
			ok: false,
			reason: localize('vibeide.metric.lastLineNotNumber', "Последняя строка вывода не число: «{0}».", lastLine.slice(0, 80)),
		};
	}
	return { ok: true, value: Number(match[1]) };
}

export const enum OptimizationVerdict {
	/** Улучшение больше порога значимости — правку оставляем. */
	Keep = 'keep',
	/** Хуже базы — откатываем. */
	Discard = 'discard',
	/** Изменение в пределах шума — откатываем: непроверяемая правка не стоит своего риска. */
	Noise = 'noise',
	/** Замер не дал числа — откатываем и говорим почему. */
	Unmeasured = 'unmeasured',
}

export interface IComparisonInput {
	readonly baseline: number;
	readonly candidate: number;
	readonly direction: MetricDirection;
	/**
	 * Порог значимости, доля от базы (0.02 = 2%). Изменения меньше него считаются шумом:
	 * замеры дрожат, и без порога агент «улучшал» бы метрику случайными правками.
	 */
	readonly noiseThreshold: number;
}

export interface IOptimizationDecision {
	readonly verdict: OptimizationVerdict;
	/** Изменение к базе: положительное — улучшение, каким бы ни было направление. */
	readonly improvement: number;
	/** Оно же долей от базы. */
	readonly improvementRatio: number;
}

export function decideOptimization(input: IComparisonInput): IOptimizationDecision {
	const { baseline, candidate, direction, noiseThreshold } = input;
	const improvement = direction === MetricDirection.Lower ? baseline - candidate : candidate - baseline;
	// База может быть нулевой (например, «ноль ошибок»): доля от нуля не определена, поэтому
	// при нулевой базе любое ненулевое изменение считаем значимым.
	const scale = Math.abs(baseline);
	const improvementRatio = scale > 0 ? improvement / scale : (improvement === 0 ? 0 : Infinity);

	if (Math.abs(improvementRatio) < noiseThreshold) {
		return { verdict: OptimizationVerdict.Noise, improvement, improvementRatio };
	}
	return {
		verdict: improvement > 0 ? OptimizationVerdict.Keep : OptimizationVerdict.Discard,
		improvement,
		improvementRatio,
	};
}

/** Одна попытка в журнале оптимизации. */
export interface IOptimizationAttempt {
	readonly attempt: number;
	readonly summary: string;
	readonly value?: number;
	readonly verdict: OptimizationVerdict;
	readonly improvementRatio?: number;
}

/**
 * Правда ли лучший результат достигнут — или агент кружит на месте.
 *
 * Нужен, чтобы вовремя остановиться: серия попыток подряд без улучшения означает, что дешёвые
 * идеи кончились, и продолжать значит жечь бюджет. Порог задаёт вызывающий: у разных задач
 * разная плотность идей.
 */
export function consecutiveFailures(attempts: readonly IOptimizationAttempt[]): number {
	let count = 0;
	for (let i = attempts.length - 1; i >= 0; i--) {
		if (attempts[i].verdict === OptimizationVerdict.Keep) {
			break;
		}
		count++;
	}
	return count;
}

/** Лучшее достигнутое значение, или база, если ни одна попытка не удержалась. */
export function bestValue(baseline: number, attempts: readonly IOptimizationAttempt[], direction: MetricDirection): number {
	let best = baseline;
	for (const attempt of attempts) {
		if (attempt.verdict !== OptimizationVerdict.Keep || attempt.value === undefined) {
			continue;
		}
		best = direction === MetricDirection.Lower ? Math.min(best, attempt.value) : Math.max(best, attempt.value);
	}
	return best;
}

/** «−12,4 %» / «+3,0 %» — знак всегда со стороны пользы, а не арифметики. */
export function formatImprovement(ratio: number): string {
	if (!Number.isFinite(ratio)) {
		return ratio > 0 ? '+∞' : '−∞';
	}
	const percent = (Math.abs(ratio) * 100).toFixed(1).replace('.', ',');
	return `${ratio >= 0 ? '+' : '−'}${percent} %`;
}

/** Строка вердикта для чата и журнала. */
export function describeVerdict(decision: IOptimizationDecision, reason?: string): string {
	switch (decision.verdict) {
		case OptimizationVerdict.Keep:
			return localize('vibeide.metric.keep', "Оставляем: метрика улучшилась на {0}.", formatImprovement(decision.improvementRatio));
		case OptimizationVerdict.Discard:
			return localize('vibeide.metric.discard', "Откатываем: метрика ухудшилась на {0}.", formatImprovement(Math.abs(decision.improvementRatio)));
		case OptimizationVerdict.Noise:
			return localize('vibeide.metric.noise', "Откатываем: изменение {0} в пределах шума замера.", formatImprovement(decision.improvementRatio));
		default:
			return localize('vibeide.metric.unmeasured', "Откатываем: замер не дал числа. {0}", reason ?? '');
	}
}
