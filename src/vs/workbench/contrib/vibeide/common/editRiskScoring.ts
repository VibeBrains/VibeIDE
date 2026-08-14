/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Оценка риска правки — чистая часть.
 *
 * Правило решает одно: спросить ли человека, когда включено автоодобрение. Поэтому цена ошибки
 * несимметрична. Лишний вопрос стоит одного клика; пропущенная правка `.env` или файла workflow
 * стоит утёкшего ключа или изменённого пайплайна выпуска.
 *
 * Логика вынесена из сервиса, потому что раньше она была сплетена с `IModelService` и
 * `IMarkerService` и поэтому не покрывалась тестами вовсе. Проверка 14.08.2026 показала, к чему
 * это привело: пять дефектов, каждый арифметически очевидный при взгляде на голые числа, но
 * невидимый внутри сервиса.
 *
 * Что было сломано (зафиксировано тестами ниже по файлу от этого модуля):
 *
 *  1. **Критический файл автоодобрялся.** `.env`, `.github/workflows/*`, `package.json` давали
 *     ровно 0.5 при пороге «строго больше 0.6» — то есть MEDIUM, то есть проходили без вопроса.
 *  2. **Ветка низкой уверенности была мертва.** Уверенность стартовала с 0.7 и опускалась максимум
 *     до 0.65, а порог стоял на 0.5 — условие не выполнялось никогда.
 *  3. **LOW был недостижим.** Требовалось `confidence > 0.7` строго при базовом значении ровно 0.7,
 *     поэтому правка одной строки комментария объявлялась MEDIUM.
 *  4. **`test/` ловил `latest/` и `protest/`** — подстрока без границ сегмента пути.
 *  5. **Тестовый файл ПОВЫШАЛ риск** на 0.2, хотя комментарий рядом обещал обратное.
 *
 * Чего здесь намеренно НЕТ: оценки качества модели по её имени. Она устаревает с каждым релизом
 * вендора (список знал `gpt-4`, но не `gpt-5.6`), и «уверенность» начинала зависеть от того,
 * успели ли мы дописать подстроку в массив. Уверенность считается по фактам правки — читали ли
 * файл, насколько велика замена, — а не по репутации имени.
 */

import { localize } from '../../../../nls.js';

export type EditOperation = 'rewrite_file' | 'edit_file' | 'create_file_or_folder' | 'delete_file_or_folder';

export type EditRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** Чистый вход: всё, что нужно для оценки, уже прочитано вызывающим. */
export interface IEditRiskInput {
	readonly operation: EditOperation;
	/** Путь файла в POSIX-виде или как есть — сравнение регистронезависимое. */
	readonly filePath: string;
	readonly originalLength?: number;
	readonly newLength?: number;
	/** Сколько ошибок уже висит на файле. */
	readonly existingErrorCount?: number;
	/** Читал ли агент файл перед правкой. */
	readonly fileWasRead?: boolean;
	/** Сколько файлов затрагивает операция целиком. */
	readonly totalFilesInOperation?: number;
}

export interface IEditRiskScore {
	readonly riskScore: number;
	readonly confidenceScore: number;
	readonly riskLevel: EditRiskLevel;
	readonly riskFactors: string[];
	readonly confidenceFactors: string[];
}

/**
 * Веса и пороги одним объектом.
 *
 * Собраны здесь не ради красоты: разбросанные по ветвям литералы и дали дефекты 1–3 — глядя на
 * `+= 0.5` внутри одного `if`, нельзя увидеть, что сумма никогда не переваливает за порог,
 * стоящий двумястами строками ниже.
 */
export const EDIT_RISK_WEIGHTS = {
	/** Правка файла с секретами, манифестом сборки или пайплайном. Одна её достаточно для HIGH. */
	criticalFile: 0.7,
	/** Тестовый файл: продакшен от него не падает, откат стоит дёшево. */
	testFile: -0.1,
	/** Перезапись, меняющая размер файла более чем на половину. */
	largeRewriteMax: 0.6,
	largeRewriteFactor: 0.8,
	largeRewriteFrom: 0.5,
	/** Правка файла, на котором уже висят ошибки. */
	brokenFile: 0.2,
	brokenFileFrom: 5,
	/** Каждый файл сверх первого в одной операции. */
	perExtraFile: 0.1,
	perExtraFileMax: 0.3,
	/** Создание нового файла — почти безрисково, пока это не критический файл. */
	createFloor: 0.05,
} as const;

export const EDIT_CONFIDENCE_WEIGHTS = {
	base: 0.7,
	/** Файл прочитан перед правкой — агент знает, что заменяет. */
	fileWasRead: 0.1,
	/**
	 * Перезапись файла, которого не читали, — самый опасный из тихих сценариев: содержимое
	 * стирается целиком, и вместе с ним чужие правки, о существовании которых агент не знал.
	 * Веса хватает, чтобы одна эта комбинация дала HIGH без всякого риска по файлу.
	 */
	rewroteBlind: -0.25,
	/**
	 * Точечная замена вслепую опасна умереннее: строку для замены агент откуда-то узнал, и
	 * несовпадение он увидит. Ставить сюда тот же вес значило бы спрашивать человека на каждой
	 * правке после `grep` — цена, за которую подтверждения начинают прокликивать не глядя.
	 */
	editedBlind: -0.1,
	/** Полная перезапись рискованнее точечной замены. */
	rewrite: -0.05,
	/** Замена меняет меньше десятой части файла. */
	smallChange: 0.05,
} as const;

export interface IEditRiskThresholds {
	/** Не выше — LOW (при достаточной уверенности). */
	readonly lowRiskAtMost: number;
	/** Не ниже — HIGH. */
	readonly highRiskAtLeast: number;
	/** Не ниже — уверенности хватает для LOW. */
	readonly lowNeedsConfidence: number;
	/** Не выше — уверенности так мало, что это HIGH независимо от риска. */
	readonly highIfConfidenceAtMost: number;
}

/**
 * Пороги.
 *
 * Все сравнения нестрогие с обеих сторон намеренно: строгое `>` и дало дефект «LOW недостижим»,
 * когда значение попадало ровно на границу. Граница должна принадлежать одной из сторон явно.
 */
export const DEFAULT_EDIT_RISK_THRESHOLDS: IEditRiskThresholds = {
	lowRiskAtMost: 0.2,
	highRiskAtLeast: 0.6,
	lowNeedsConfidence: 0.7,
	highIfConfidenceAtMost: 0.5,
};

/** Файлы, правка которых меняет секреты, сборку или выпуск. */
const CRITICAL_FILE_PATTERNS: readonly RegExp[] = [
	/(^|\/)package\.json$/i,
	/(^|\/)package-lock\.json$/i,
	/(^|\/)yarn\.lock$/i,
	/(^|\/)pnpm-lock\.yaml$/i,
	/(^|\/)tsconfig(\.\w+)?\.json$/i,
	/(^|\/)jsconfig\.json$/i,
	/(^|\/)webpack\.config\./i,
	/(^|\/)vite\.config\./i,
	/(^|\/)\.env$/i,
	/(^|\/)\.env\./i,
	/(^|\/)dockerfile$/i,
	/(^|\/)docker-compose\./i,
	/(^|\/)\.gitignore$/i,
	/(^|\/)\.gitattributes$/i,
	/(^|\/)\.github\/workflows\//i,
	/(^|\/)\.github\/actions\//i,
	/(^|\/)ci\.ya?ml$/i,
];

/**
 * Тестовые файлы.
 *
 * Каталоги якорятся границей сегмента (`(^|\/)test\//`), иначе `src/latest/api.ts` и
 * `app/protest/main.ts` считались тестами — обе строки содержат подстроку `test/`.
 */
const TEST_FILE_PATTERNS: readonly RegExp[] = [
	/\.(test|spec)\.[^/]+$/i,
	/(^|\/)__tests__\//i,
	/(^|\/)__mocks__\//i,
	/(^|\/)tests?\//i,
	/(^|\/)test_[^/]+$/i,
];

export const isCriticalFile = (filePath: string): boolean =>
	CRITICAL_FILE_PATTERNS.some(pattern => pattern.test(filePath));

export const isTestFile = (filePath: string): boolean =>
	TEST_FILE_PATTERNS.some(pattern => pattern.test(filePath));

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const sizeChangeRatio = (input: IEditRiskInput): number | undefined => {
	if (input.originalLength === undefined || input.newLength === undefined) { return undefined; }
	return Math.abs(input.newLength - input.originalLength) / Math.max(input.originalLength, 1);
};

/**
 * Оценка риска и уверенности.
 *
 * Возвращает и число, и причины: без причин пользователь видит вердикт «HIGH» и не понимает, что
 * именно его вызвало, — а решение о правке принимает он.
 */
export function scoreEditRisk(
	input: IEditRiskInput,
	thresholds: IEditRiskThresholds = DEFAULT_EDIT_RISK_THRESHOLDS,
): IEditRiskScore {
	const riskFactors: string[] = [];
	const confidenceFactors: string[] = [];
	const fileName = input.filePath.split(/[\\/]/).pop() ?? input.filePath;

	// Удаление — единственный необратимый случай: содержимое исчезает целиком, и «откатить»
	// означает восстановить его из чужой памяти.
	if (input.operation === 'delete_file_or_folder') {
		return {
			riskScore: 1,
			confidenceScore: 0.5,
			riskLevel: 'HIGH',
			riskFactors: [localize('vibeide.editRisk.deletion', "Удаление: {0}", fileName)],
			confidenceFactors: [localize('vibeide.editRisk.deletionConfidence', "Удаление всегда требует подтверждения человека.")],
		};
	}

	let risk = 0;
	const critical = isCriticalFile(input.filePath);
	if (critical) {
		risk += EDIT_RISK_WEIGHTS.criticalFile;
		riskFactors.push(localize('vibeide.editRisk.critical', "Критический файл: {0} — секреты, сборка или выпуск", fileName));
	}
	if (isTestFile(input.filePath)) {
		risk += EDIT_RISK_WEIGHTS.testFile;
		confidenceFactors.push(localize('vibeide.editRisk.testFile', "Тестовый файл — продакшен от правки не меняется."));
	}

	const ratio = sizeChangeRatio(input);
	if (input.operation === 'rewrite_file' && ratio !== undefined && ratio > EDIT_RISK_WEIGHTS.largeRewriteFrom) {
		risk += Math.min(EDIT_RISK_WEIGHTS.largeRewriteMax, ratio * EDIT_RISK_WEIGHTS.largeRewriteFactor);
		riskFactors.push(localize('vibeide.editRisk.largeChange', "Крупная замена: размер меняется на {0}%", Math.round(ratio * 100)));
	}

	if ((input.existingErrorCount ?? 0) > EDIT_RISK_WEIGHTS.brokenFileFrom) {
		risk += EDIT_RISK_WEIGHTS.brokenFile;
		riskFactors.push(localize('vibeide.editRisk.broken', "В файле уже {0} ошибок", input.existingErrorCount));
	}

	const extraFiles = Math.max(0, (input.totalFilesInOperation ?? 1) - 1);
	if (extraFiles > 0) {
		risk += Math.min(EDIT_RISK_WEIGHTS.perExtraFileMax, extraFiles * EDIT_RISK_WEIGHTS.perExtraFile);
		riskFactors.push(localize('vibeide.editRisk.multiFile', "Операция затрагивает файлов: {0}", input.totalFilesInOperation));
	}

	// Создание файла: пола риска достаточно, если ничего опаснее не нашлось. Критический файл
	// сюда не попадает — его вес уже выставлен выше и он больше пола.
	if (input.operation === 'create_file_or_folder') {
		risk = Math.max(EDIT_RISK_WEIGHTS.createFloor, risk);
		if (!critical) {
			confidenceFactors.push(localize('vibeide.editRisk.newFile', "Новый файл — ничего существующего не перезаписывается."));
		}
	}

	let confidence = EDIT_CONFIDENCE_WEIGHTS.base;
	if (input.fileWasRead) {
		confidence += EDIT_CONFIDENCE_WEIGHTS.fileWasRead;
		confidenceFactors.push(localize('vibeide.editRisk.wasRead', "Файл прочитан перед правкой."));
	} else if (input.operation === 'rewrite_file') {
		// Правка вслепую — это и есть случай низкой уверенности. Раньше её ничто не понижало,
		// поэтому порог по уверенности не срабатывал никогда.
		confidence += EDIT_CONFIDENCE_WEIGHTS.rewroteBlind;
		confidenceFactors.push(localize('vibeide.editRisk.blindRewrite', "Файл переписывается целиком, не будучи прочитанным."));
	} else if (input.operation !== 'create_file_or_folder') {
		confidence += EDIT_CONFIDENCE_WEIGHTS.editedBlind;
		confidenceFactors.push(localize('vibeide.editRisk.blind', "Файл не читали перед правкой."));
	}
	if (input.operation === 'rewrite_file') {
		confidence += EDIT_CONFIDENCE_WEIGHTS.rewrite;
		confidenceFactors.push(localize('vibeide.editRisk.rewrite', "Перезапись файла целиком."));
	}
	if (ratio !== undefined && ratio < 0.1) {
		confidence += EDIT_CONFIDENCE_WEIGHTS.smallChange;
		confidenceFactors.push(localize('vibeide.editRisk.smallChange', "Небольшое изменение."));
	}

	const riskScore = clamp01(risk);
	const confidenceScore = clamp01(confidence);

	const riskLevel: EditRiskLevel =
		riskScore >= thresholds.highRiskAtLeast || confidenceScore <= thresholds.highIfConfidenceAtMost
			? 'HIGH'
			: riskScore <= thresholds.lowRiskAtMost && confidenceScore >= thresholds.lowNeedsConfidence
				? 'LOW'
				: 'MEDIUM';

	return {
		riskScore,
		confidenceScore,
		riskLevel,
		riskFactors: riskFactors.length > 0 ? riskFactors : [localize('vibeide.editRisk.none', "Ничего настораживающего.")],
		confidenceFactors: confidenceFactors.length > 0 ? confidenceFactors : [localize('vibeide.editRisk.standard', "Обычная правка.")],
	};
}
