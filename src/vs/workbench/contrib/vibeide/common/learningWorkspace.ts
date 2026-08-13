/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Учебный workspace: обучение, которое переживает конец треда.
 *
 * Тред хранит КОНТЕКСТ, обучению же нужен ПРОГРЕСС. Разговор рано или поздно кончается — вместе с
 * ним исчезает и знание о том, что ученик уже освоил, а на чём спотыкается второй раз подряд. На
 * следующий день приходится заново объяснять цель и повторять пройденное, и модель честно учит с
 * начала, потому что другого входа у неё нет.
 *
 * Здесь прогресс лежит файлами. Следующая сессия стартует не с нуля, а с того, что на диске:
 * миссия (зачем это вообще), источники (чем разрешено учить), уроки и — главное — следы обучения:
 * что понято и где застряли.
 *
 * Два решения, ради которых модуль вообще существует:
 *
 *  1. **Миссия — гейт, а не анкета.** Пока не отвечено, зачем навык нужен именно сейчас, что
 *     ученик уже умеет сам, как выглядит успех и в каком виде ему удобно учиться, урок не строится.
 *     Без этого «научи меня питону» превращается в пересказ оглавления учебника — верный и
 *     бесполезный.
 *  2. **Сложность выбирает код по данным, а не модель по впечатлению.** Слишком легко — иллюзия
 *     прогресса, слишком сложно — перегрузка; держаться надо в зоне ближайшего развития. Модель,
 *     оценивающая собственный урок, систематически считает его удачным — тот же конфликт интересов,
 *     что и у агента, судящего свою оптимизацию (см. `metricOptimization.ts`). Поэтому решение
 *     принимается из записей о застреваниях, а модели возвращается уже готовый вердикт.
 *
 * Чистый модуль: ни файловой системы, ни сервисов — проверяется из `test/common/`.
 */

import { localize } from '../../../../nls.js';

/** Корень учебного workspace внутри рабочей папки — рядом с хендоффами, навыками и правилами. */
export const LEARNING_DIR = '.vibe/learning';

/** Файл миссии: зачем и куда учимся. Без него обучение не начинается. */
export const MISSION_FILE = 'MISSION.md';
/** Доверенные первоисточники: чем разрешено учить, чтобы уроки не шли из памяти модели. */
export const RESOURCES_FILE = 'RESOURCES.md';
/** Предпочтения ученика: темп, формат, что раздражает. */
export const NOTES_FILE = 'NOTES.md';
/** Сами уроки — по одной узкой теме на файл. */
export const LESSONS_SUBDIR = 'lessons';
/** Следы обучения: что освоено и где застряли. Именно они делают систему накопительной. */
export const RECORDS_SUBDIR = 'records';
/** Выжимки: шпаргалки, глоссарии, синтаксис. */
export const REFERENCE_SUBDIR = 'reference';

/**
 * Миссия — четыре ответа, без которых первый урок не строится.
 *
 * Разделы именно эти, потому что каждый снимает свой класс промаха: без `why` учат вообще, без
 * `level` — уже известное, без `success` некому сказать «дошли», без `format` уроки идут в виде,
 * который ученик не переносит.
 */
export interface ILearningMission {
	/** Зачем этот навык нужен именно сейчас. */
	readonly why: string;
	/** Что ученик уже умеет делать самостоятельно. */
	readonly level: string;
	/** Как выглядит реальный успех — признак, по которому обучение можно закончить. */
	readonly success: string;
	/** Как ученику удобнее учиться и практиковаться. */
	readonly format: string;
}

/** Заголовки разделов миссии, которые пишем мы; при разборе принимаются и синонимы. */
const MISSION_TITLES = {
	why: 'Зачем',
	level: 'Текущий уровень',
	success: 'Критерий успеха',
	format: 'Формат',
} as const;

type MissionKey = keyof typeof MISSION_TITLES;

const MISSION_ALIASES: Record<MissionKey, readonly string[]> = {
	why: ['зачем', 'цель', 'миссия', 'почему сейчас', 'why', 'goal', 'mission'],
	level: ['текущий уровень', 'уровень', 'что умею', 'level', 'current level', 'baseline'],
	success: ['критерий успеха', 'успех', 'результат', 'success', 'success criteria', 'outcome'],
	format: ['формат', 'как учиться', 'предпочтения', 'format', 'how i learn', 'style'],
};

/** Вопрос, который задаётся ученику, когда раздел миссии пуст. */
const MISSION_QUESTIONS: Record<MissionKey, string> = {
	why: 'Зачем этот навык нужен именно сейчас?',
	level: 'Что вы уже умеете делать самостоятельно?',
	success: 'Как будет выглядеть реальный успех?',
	format: 'Как вам удобнее учиться и практиковаться?',
};

/**
 * След одного урока: что освоено и где застряли.
 *
 * `stuck` — не жалоба, а данные: по повторяющимся застреваниям вычисляется сложность следующего
 * урока. Поэтому темы застревания идут отдельными пунктами, а не прозой: строку «было тяжеловато»
 * сравнить с прошлой невозможно, а тему — можно.
 */
export interface ILearningRecord {
	/** Урок, к которому относится запись. */
	readonly lesson: string;
	/** Что ученик освоил — проверяемо, а не «ознакомился». */
	readonly learned: readonly string[];
	/** На чём застрял: короткие темы, сопоставимые между уроками. */
	readonly stuck: readonly string[];
	readonly createdAtMs: number;
}

/** Куда двигать сложность следующего урока. */
export const enum NextDifficulty {
	/** Прошлое не усвоено — вернуться к нему, а не идти дальше. */
	Easier = 'easier',
	/** Держать текущий уровень: что-то далось, что-то нет. */
	Hold = 'hold',
	/** Ученик идёт без запинок — шаг вперёд, иначе это иллюзия прогресса. */
	Harder = 'harder',
}

/** Настройки порогов: пользовательски-значимые величины, поэтому не литералы в коде. */
export interface IDifficultyThresholds {
	/** Сколько раз тема должна повториться в застреваниях, чтобы вернуться назад. */
	readonly stuckRepeatsForEasier: number;
	/** Сколько уроков подряд без застреваний, чтобы усложнить. */
	readonly cleanRunForHarder: number;
}

export const DEFAULT_DIFFICULTY_THRESHOLDS: IDifficultyThresholds = {
	stuckRepeatsForEasier: 2,
	cleanRunForHarder: 2,
};

export interface IDifficultyVerdict {
	readonly difficulty: NextDifficulty;
	/** Почему так решено — фразой, которую можно показать ученику. */
	readonly reason: string;
	/** Темы, к которым нужно вернуться (непусто только при `easier`). */
	readonly revisit: readonly string[];
}

/** Нормализация заголовка для сопоставления с синонимами. */
const normalizeHeading = (text: string): string =>
	text.toLowerCase().replace(/[`*_#:]/g, '').replace(/\s+/g, ' ').trim();

function missionKeyOf(heading: string): MissionKey | undefined {
	const normalized = normalizeHeading(heading);
	for (const [key, aliases] of Object.entries(MISSION_ALIASES)) {
		if (aliases.some(alias => normalized === alias || normalized.startsWith(`${alias} `))) {
			return key as MissionKey;
		}
	}
	return undefined;
}

/**
 * Разбор миссии. Терпимый: незнакомые разделы игнорируются, знакомые узнаются по синонимам —
 * миссию пишет человек руками, и отказ на слове «Цель» вместо «Зачем» был бы отказом ради
 * формальности.
 */
export function parseMission(markdown: string): ILearningMission {
	const buckets: Record<MissionKey, string[]> = { why: [], level: [], success: [], format: [] };
	let current: MissionKey | undefined;
	let inFront = false;

	for (const line of (markdown ?? '').split(/\r?\n/)) {
		if (line.trim() === '---') {
			inFront = !inFront;
			continue;
		}
		if (inFront) { continue; }
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			current = missionKeyOf(heading[2]);
			continue;
		}
		if (!current) { continue; }
		const text = line.replace(/^\s*[-*]\s+/, '').trim();
		// Заглушка пустого раздела — наша же; вернуть её как ответ значит объявить миссию заполненной.
		if (!text || /^—?\s*не указано$/i.test(text) || text.startsWith('<!--')) { continue; }
		buckets[current].push(text);
	}

	return {
		why: buckets.why.join(' ').trim(),
		level: buckets.level.join(' ').trim(),
		success: buckets.success.join(' ').trim(),
		format: buckets.format.join(' ').trim(),
	};
}

/** Рендер миссии в markdown — тот же формат, что ждёт `parseMission`. */
export function renderMission(mission: ILearningMission): string {
	const section = (key: MissionKey) => {
		const value = mission[key].trim();
		return `## ${MISSION_TITLES[key]}\n${value || '— не указано'}`;
	};
	return [
		'# Миссия обучения',
		'',
		section('why'),
		'',
		section('level'),
		'',
		section('success'),
		'',
		section('format'),
		'',
	].join('\n');
}

/**
 * Чего не хватает миссии — вопросами ученику, а не кодами ошибок.
 *
 * Возвращается список ВОПРОСОВ, потому что получатель этого списка — агент, которому предстоит их
 * задать. Список «отсутствует поле why» он переведёт сам, и переведёт хуже.
 */
export function missingMissionQuestions(mission: ILearningMission): string[] {
	const keys: MissionKey[] = ['why', 'level', 'success', 'format'];
	return keys.filter(key => !mission[key].trim()).map(key => MISSION_QUESTIONS[key]);
}

/** Готова ли миссия к тому, чтобы строить по ней урок. */
export function isMissionReady(mission: ILearningMission): boolean {
	return missingMissionQuestions(mission).length === 0;
}

/** Рендер следа урока. Формат читается человеком и переживает смену инструмента. */
export function renderRecord(record: ILearningRecord): string {
	const list = (items: readonly string[]) => items.length > 0
		? items.map(item => `- ${item.trim()}`).join('\n')
		: '- — не указано';
	return [
		'---',
		`lesson: ${JSON.stringify(record.lesson)}`,
		`created: ${new Date(record.createdAtMs).toISOString()}`,
		'---',
		'',
		`# ${record.lesson}`,
		'',
		'## Освоено',
		list(record.learned),
		'',
		'## Застрял',
		list(record.stuck),
		'',
	].join('\n');
}

/** Разбор следа урока — обратная операция к `renderRecord`, терпимая к ручной правке. */
export function parseRecord(markdown: string): ILearningRecord | undefined {
	if (!(markdown ?? '').trim()) { return undefined; }
	let lesson = '';
	let created = 0;
	const learned: string[] = [];
	const stuck: string[] = [];
	let current: 'learned' | 'stuck' | undefined;
	let inFront = false;

	for (const line of markdown.split(/\r?\n/)) {
		if (line.trim() === '---') {
			inFront = !inFront;
			continue;
		}
		if (inFront) {
			const pair = /^(\w+):\s*(.+)$/.exec(line.trim());
			if (!pair) { continue; }
			const value = pair[2].trim().replace(/^"(.*)"$/, '$1');
			if (pair[1] === 'lesson') { lesson = value; }
			if (pair[1] === 'created') {
				const parsed = Date.parse(value);
				if (Number.isFinite(parsed)) { created = parsed; }
			}
			continue;
		}
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			const normalized = normalizeHeading(heading[2]);
			if (normalized.startsWith('освоено') || normalized.startsWith('learned')) { current = 'learned'; }
			else if (normalized.startsWith('застрял') || normalized.startsWith('stuck')) { current = 'stuck'; }
			else {
				current = undefined;
				if (!lesson) { lesson = heading[2].trim(); }
			}
			continue;
		}
		if (!current) { continue; }
		const text = line.replace(/^\s*[-*]\s+/, '').trim();
		if (!text || /^—?\s*не указано$/i.test(text)) { continue; }
		(current === 'learned' ? learned : stuck).push(text);
	}

	if (!lesson && learned.length === 0 && stuck.length === 0) { return undefined; }
	return { lesson: lesson || 'Без названия', learned, stuck, createdAtMs: created };
}

/** Ключ темы застревания: сравниваем по смыслу строки, а не по её оформлению. */
const stuckKey = (text: string): string =>
	text.toLowerCase().replace(/[.,;:!?()«»"'`]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Куда двигать сложность следующего урока.
 *
 * Порядок проверок не случаен: **застревание сильнее чистой серии**. Ученик, который трижды подряд
 * спотыкается об одно и то же, мог параллельно отвечать на всё остальное — усложнять ему урок
 * значит закапывать пробел глубже. Поэтому повтор проверяется первым и перекрывает `harder`.
 *
 * Серия считается по ПОСЛЕДНИМ записям, а не по всей истории: обучение месячной давности не
 * характеризует сегодняшнюю готовность.
 */
export function nextDifficulty(
	records: readonly ILearningRecord[],
	thresholds: IDifficultyThresholds = DEFAULT_DIFFICULTY_THRESHOLDS,
): IDifficultyVerdict {
	const stuckRepeats = Math.max(1, Math.floor(thresholds.stuckRepeatsForEasier));
	const cleanRun = Math.max(1, Math.floor(thresholds.cleanRunForHarder));

	if (records.length === 0) {
		return {
			difficulty: NextDifficulty.Hold,
			reason: localize('vibeide.learning.noRecords', "Следов обучения ещё нет — первый урок строится по миссии, а не по прогрессу."),
			revisit: [],
		};
	}

	const ordered = [...records].sort((a, b) => a.createdAtMs - b.createdAtMs);

	// Тема, повторившаяся в застреваниях, — единственный сигнал, который перекрывает всё остальное.
	const counts = new Map<string, { readonly text: string; count: number }>();
	for (const record of ordered) {
		// В пределах одного урока тема считается один раз: три формулировки одной и той же
		// трудности за один вечер — это одна трудность, а не три.
		const seen = new Set<string>();
		for (const item of record.stuck) {
			const key = stuckKey(item);
			if (!key || seen.has(key)) { continue; }
			seen.add(key);
			const entry = counts.get(key);
			if (entry) { entry.count += 1; } else { counts.set(key, { text: item.trim(), count: 1 }); }
		}
	}
	const revisit = [...counts.values()].filter(entry => entry.count >= stuckRepeats).map(entry => entry.text);
	if (revisit.length > 0) {
		return {
			difficulty: NextDifficulty.Easier,
			reason: localize('vibeide.learning.repeatedStuck', "Одна и та же трудность повторяется — следующий урок разбирает её заново, а не идёт дальше."),
			revisit,
		};
	}

	const tail = ordered.slice(-cleanRun);
	if (tail.length >= cleanRun && tail.every(record => record.stuck.length === 0)) {
		return {
			difficulty: NextDifficulty.Harder,
			reason: localize('vibeide.learning.cleanRun', "Последние уроки прошли без застреваний — шаг вперёд, иначе это иллюзия прогресса."),
			revisit: [],
		};
	}

	return {
		difficulty: NextDifficulty.Hold,
		reason: localize('vibeide.learning.hold', "Что-то далось, что-то нет — держим текущий уровень."),
		revisit: [],
	};
}

/** Сводка учебного workspace — то, с чего агент начинает каждую сессию. */
export interface ILearningSummary {
	readonly mission: ILearningMission;
	readonly missionReady: boolean;
	readonly missingQuestions: readonly string[];
	readonly lessonCount: number;
	readonly records: readonly ILearningRecord[];
	readonly verdict: IDifficultyVerdict;
}

/**
 * Сборка сводки из уже прочитанных кусков.
 *
 * Чтение файлов остаётся снаружи — здесь только правила, поэтому их видно и можно проверить без
 * окружения.
 */
export function summarizeLearning(input: {
	readonly missionMarkdown: string;
	readonly lessonCount: number;
	readonly recordMarkdowns: readonly string[];
	readonly thresholds?: IDifficultyThresholds;
}): ILearningSummary {
	const mission = parseMission(input.missionMarkdown);
	const records = input.recordMarkdowns
		.map(parseRecord)
		.filter((record): record is ILearningRecord => record !== undefined);
	return {
		mission,
		missionReady: isMissionReady(mission),
		missingQuestions: missingMissionQuestions(mission),
		lessonCount: input.lessonCount,
		records,
		verdict: nextDifficulty(records, input.thresholds ?? DEFAULT_DIFFICULTY_THRESHOLDS),
	};
}
