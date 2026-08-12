/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Слияние находок нескольких моделей в один список.
 *
 * Зачем вообще несколько. Одиночная модель как детектор уязвимостей ненадёжна — это не наше
 * наблюдение, а вывод рецензируемого исследования: модели уверенно называют дырой безопасный код и
 * так же уверенно пропускают настоящую. Одна модель даёт список, которому нельзя верить и который
 * нельзя игнорировать; несколько моделей дают то, чего у одной нет в принципе — **согласие**.
 *
 * Что здесь считается одной находкой: строка плюс категория. Формулировки у моделей всегда разные
 * («SQL-инъекция» против «неэкранированный ввод в запрос»), сравнивать их текстами значит сравнивать
 * стиль, а не суть; строка и категория — то, что модели обязаны назвать одинаково, если видят одно
 * и то же.
 *
 * Чистый модуль: ни моделей, ни сервисов, поэтому проверяется из `test/common/`.
 */

import { CodeReviewAnnotation, ReviewSeverity } from './codeReviewService.js';

/** Находка после слияния: та же аннотация плюс то, чего у одиночного прогона нет — согласие. */
export interface MergedReviewAnnotation extends CodeReviewAnnotation {
	/** Модели, назвавшие эту находку. Длина списка и есть уровень согласия. */
	readonly agreedBy: readonly string[];
	/** Формулировки остальных моделей — их стоит показать, они часто дополняют друг друга. */
	readonly otherMessages: readonly string[];
}

export interface ReviewRun {
	/** Имя модели — то, что попадёт в `agreedBy`. */
	readonly model: string;
	readonly annotations: readonly CodeReviewAnnotation[];
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = { error: 3, warning: 2, info: 1, hint: 0 };

/**
 * Сливает прогоны и оставляет находки, набравшие нужное согласие.
 *
 * `minAgreement` применяется, только когда прогонов **больше одного**: порог 2 на единственной
 * модели вычистил бы весь список, и «нет находок» читалось бы как «чисто», хотя означало бы
 * «сравнивать было не с чем».
 *
 * Тяжесть берётся максимальная из названных: если одна модель считает это ошибкой, а вторая
 * подсказкой, занижать до подсказки — значит терять именно то, ради чего второе мнение и звали.
 */
export function mergeReviewAnnotations(
	runs: readonly ReviewRun[],
	minAgreement: number,
): MergedReviewAnnotation[] {
	const groups = new Map<string, { base: CodeReviewAnnotation; models: string[]; messages: string[]; severity: ReviewSeverity }>();

	for (const run of runs) {
		// Одна модель, назвавшая ту же строку и категорию дважды, не создаёт согласия сама с собой.
		const seenInThisRun = new Set<string>();
		for (const annotation of run.annotations) {
			const key = `${annotation.line}::${annotation.category}`;
			const existing = groups.get(key);
			if (!existing) {
				groups.set(key, {
					base: annotation,
					models: [run.model],
					messages: [annotation.message],
					severity: annotation.severity,
				});
				seenInThisRun.add(key);
				continue;
			}
			if (!seenInThisRun.has(key)) {
				existing.models.push(run.model);
				seenInThisRun.add(key);
			}
			if (!existing.messages.includes(annotation.message)) {
				existing.messages.push(annotation.message);
			}
			if (SEVERITY_RANK[annotation.severity] > SEVERITY_RANK[existing.severity]) {
				existing.severity = annotation.severity;
			}
			// Готовая правка ценнее её отсутствия — берём первую предложенную кем угодно.
			if (!existing.base.suggestedFix && annotation.suggestedFix) {
				existing.base = { ...existing.base, suggestedFix: annotation.suggestedFix };
			}
		}
	}

	const threshold = runs.length > 1 ? Math.max(1, minAgreement) : 1;
	const out: MergedReviewAnnotation[] = [];
	for (const group of groups.values()) {
		if (group.models.length < threshold) {
			continue;
		}
		out.push({
			...group.base,
			severity: group.severity,
			agreedBy: group.models,
			otherMessages: group.messages.filter(m => m !== group.base.message),
		});
	}

	// Порядок детерминирован: сначала то, где согласия больше, потом тяжесть, потом строка. Две
	// модели в разном порядке не должны давать разный отчёт по одному и тому же коду.
	out.sort((a, b) =>
		b.agreedBy.length - a.agreedBy.length
		|| SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
		|| a.line - b.line
		|| a.category.localeCompare(b.category));
	return out;
}

/**
 * Строка о согласии для отчёта.
 *
 * Число моделей названо явно: «нашли трое из трёх» и «нашла одна из трёх» — разные утверждения, и
 * читатель обязан их различать, иначе мультимодельность не даёт ничего сверх одиночного прогона.
 */
export function describeAgreement(annotation: MergedReviewAnnotation, totalRuns: number): string {
	if (totalRuns <= 1) {
		return '';
	}
	return `согласие ${annotation.agreedBy.length}/${totalRuns} (${annotation.agreedBy.join(', ')})`;
}
