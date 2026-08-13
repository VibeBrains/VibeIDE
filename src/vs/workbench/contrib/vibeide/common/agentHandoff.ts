/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Хендофф: формализованная передача работы между агентами, тредами и машинами.
 *
 * Зачем формат, а не свободный текст. Передача «на словах» ломается предсказуемо: принимающий
 * узнаёт, ЧТО делали, и не узнаёт, где споткнулись и что считать следующим шагом — а именно эти
 * два пункта и стоят дорого, потому что их нельзя восстановить чтением кода. Фиксированные разделы
 * заставляют назвать блокеры и следующий шаг явно; пустой раздел виден и читается как «не сказали»,
 * а не растворяется в прозе.
 *
 * Формат — markdown с YAML-шапкой: он читается человеком без нашего интерфейса, версионируется
 * гитом рядом с кодом и переживает смену машины. Разбор терпимый: чужой хендофф, написанный руками
 * или другим инструментом, должен читаться, даже если разделы названы иначе.
 *
 * Чистый модуль: ни файловой системы, ни сервисов — проверяется из `test/common/`.
 */

/** Куда складываются хендоффы. Рядом с планами и навыками, в рабочей папке проекта. */
export const HANDOFF_DIR = '.vibe/handoffs';

export interface AgentHandoff {
	/** Кратко: над чем работа. Первая строка, которую читает принимающий. */
	readonly title: string;
	/** Что сделано — уже готовое, а не намерения. */
	readonly done: readonly string[];
	/** Где споткнулись: то, что нельзя восстановить чтением кода. */
	readonly blockers: readonly string[];
	/** Следующий шаг — конкретное действие, а не направление. */
	readonly next: readonly string[];
	/** Состояние окружения: ветка, незакоммиченное, запущенное. Необязательно. */
	readonly environment?: string;
	/** Кто передаёт — тред, роль, машина. Для «кого спросить, если непонятно». */
	readonly from?: string;
	readonly createdAtMs: number;
}

/** Заголовки разделов, которые мы пишем; при разборе принимаются и синонимы (см. ниже). */
const SECTION_TITLES = {
	done: 'Сделано',
	blockers: 'Блокеры',
	next: 'Дальше',
	environment: 'Окружение',
} as const;

const SECTION_ALIASES: Record<keyof typeof SECTION_TITLES, readonly string[]> = {
	done: ['сделано', 'что сделано', 'done', 'completed', 'what was done', 'what i did'],
	blockers: ['блокеры', 'блокировки', 'проблемы', 'blockers', 'blocked', 'known issues'],
	next: ['дальше', 'следующий шаг', 'что дальше', 'осталось', 'next', 'next steps', 'todo', 'what is next'],
	environment: ['окружение', 'состояние окружения', 'environment', 'state'],
};

/**
 * Рендер хендоффа в markdown.
 *
 * Пустой раздел печатается явной строкой «— не указано», а не пропускается: отсутствие блокеров и
 * умолчание о них — разные сообщения, и принимающий обязан их различать. Пропуск читался бы как
 * «блокеров нет», хотя означал бы «спросить забыли».
 */
export function renderHandoff(handoff: AgentHandoff): string {
	const list = (items: readonly string[]) => items.length > 0
		? items.map(item => `- ${item.trim()}`).join('\n')
		: '- — не указано';

	const front = [
		'---',
		`title: ${JSON.stringify(handoff.title)}`,
		handoff.from ? `from: ${JSON.stringify(handoff.from)}` : undefined,
		`created: ${new Date(handoff.createdAtMs).toISOString()}`,
		'---',
	].filter(Boolean).join('\n');

	const body = [
		`# ${handoff.title}`,
		'',
		`## ${SECTION_TITLES.done}`,
		list(handoff.done),
		'',
		`## ${SECTION_TITLES.blockers}`,
		list(handoff.blockers),
		'',
		`## ${SECTION_TITLES.next}`,
		list(handoff.next),
	];
	if (handoff.environment?.trim()) {
		body.push('', `## ${SECTION_TITLES.environment}`, handoff.environment.trim());
	}
	return `${front}\n\n${body.join('\n')}\n`;
}

/** Нормализация заголовка для сопоставления с синонимами. */
const normalizeHeading = (text: string): string =>
	text.toLowerCase().replace(/[`*_#:]/g, '').replace(/\s+/g, ' ').trim();

function sectionKeyOf(heading: string): keyof typeof SECTION_TITLES | undefined {
	const normalized = normalizeHeading(heading);
	for (const [key, aliases] of Object.entries(SECTION_ALIASES)) {
		if (aliases.some(alias => normalized === alias || normalized.startsWith(`${alias} `))) {
			return key as keyof typeof SECTION_TITLES;
		}
	}
	return undefined;
}

/**
 * Разбор хендоффа. Терпимый: незнакомые разделы игнорируются, знакомые узнаются по синонимам.
 *
 * Заглушка «— не указано» распознаётся и превращается обратно в пустой список — иначе она уехала бы
 * дальше как содержательный пункт и следующий принимающий счёл бы её задачей.
 */
export function parseHandoff(markdown: string): AgentHandoff | undefined {
	if (!markdown.trim()) {
		return undefined;
	}
	const lines = markdown.split(/\r?\n/);
	let title = '';
	let from: string | undefined;
	let created: number | undefined;
	const buckets: Record<keyof typeof SECTION_TITLES, string[]> = { done: [], blockers: [], next: [], environment: [] };
	let current: keyof typeof SECTION_TITLES | undefined;
	let inFront = false;

	for (const line of lines) {
		if (line.trim() === '---') {
			inFront = !inFront;
			continue;
		}
		if (inFront) {
			const pair = /^(\w+):\s*(.+)$/.exec(line.trim());
			if (!pair) { continue; }
			const value = pair[2].trim().replace(/^"(.*)"$/, '$1');
			if (pair[1] === 'title') { title = value; }
			if (pair[1] === 'from') { from = value; }
			if (pair[1] === 'created') {
				const parsed = Date.parse(value);
				if (Number.isFinite(parsed)) { created = parsed; }
			}
			continue;
		}
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			const key = sectionKeyOf(heading[2]);
			current = key;
			if (!key && !title) { title = heading[2].trim(); }
			continue;
		}
		if (!current) { continue; }
		const text = line.replace(/^\s*[-*]\s+/, '').trim();
		// «— не указано» — наша же заглушка пустого раздела; вернуть её как пункт значит выдумать задачу.
		if (!text || /^—?\s*не указано$/i.test(text)) { continue; }
		buckets[current].push(text);
	}

	if (!title && buckets.done.length === 0 && buckets.next.length === 0) {
		return undefined;
	}
	return {
		title: title || 'Без названия',
		done: buckets.done,
		blockers: buckets.blockers,
		next: buckets.next,
		environment: buckets.environment.length > 0 ? buckets.environment.join('\n') : undefined,
		from,
		createdAtMs: created ?? 0,
	};
}

/**
 * Что не так с хендоффом — списком, для показа автору.
 *
 * Не бросает и не блокирует запись: неполный хендофф лучше ненаписанного, а решать, дописывать ли,
 * должен человек. Молчаливая же запись пустого «Дальше» и есть та передача «на словах», ради
 * замены которой формат заводился.
 */
export function validateHandoff(handoff: AgentHandoff): string[] {
	const problems: string[] = [];
	if (!handoff.title.trim()) { problems.push('нет названия — принимающий не поймёт, о чём это'); }
	if (handoff.done.length === 0) { problems.push('пустое «Сделано» — непонятно, от чего отталкиваться'); }
	if (handoff.next.length === 0) { problems.push('пустое «Дальше» — это главное, ради чего хендофф и пишут'); }
	return problems;
}
