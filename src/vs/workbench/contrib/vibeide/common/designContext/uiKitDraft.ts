/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Черновик карты UI, снятый с кода проекта.
 *
 * Карту можно написать руками, но тогда она устареет к следующей неделе и будет врать — а карта,
 * которая врёт, хуже отсутствующей: агент сошлётся на компонент, которого больше нет. Поэтому
 * первичный источник — сам код: что реально объявлено, то в карту и попадает.
 *
 * Собирается ровно три вещи, потому что именно их модель придумывает заново:
 *  - **токены** (`--custom-property`) — значения, которые нельзя изобретать;
 *  - **классы компонентов** — имена, на которые ссылаются в задаче;
 *  - **экспортированные компоненты** — то, что уже написано и работает.
 *
 * Чисто: на вход список файлов, на выход markdown. Никакого доступа к диску, поэтому проверяется
 * без окружения — а обход файлов остаётся заботой вызывающего.
 */

export interface UiKitSourceFile {
	/** Путь относительно корня проекта. */
	readonly path: string;
	readonly content: string;
}

export interface UiKitDraftLayer {
	readonly layer: string;
	readonly file: string;
	readonly contains: string;
}

export interface UiKitDraft {
	readonly layers: readonly UiKitDraftLayer[];
	/** Имена, на которые агент сможет ссылаться дословно. */
	readonly names: readonly string[];
	readonly markdown: string;
}

/** Сколько имён показывать в одной строке карты: длинный хвост её не улучшает, а читать мешает. */
const MAX_NAMES_PER_LAYER = 12;

/**
 * Классы-утилиты, которые встречаются в любом проекте с Tailwind и подобными.
 *
 * Они не компоненты: сослаться в задаче на `.mt-4` бессмысленно, а карта, забитая ими, скрывает
 * настоящие имена. Отсекаются по форме, а не по списку — списка всех утилит не существует.
 */
const UTILITY_CLASS = /^(?:[mp][trblxy]?-|w-|h-|gap-|flex|grid|text-|bg-|border-|rounded-|shadow-|items-|justify-|space-|col-|row-|z-|opacity-|hidden$|block$|inline)/;

function isMeaningfulClass(name: string): boolean {
	if (name.length < 2 || name.length > 40) { return false; }
	if (UTILITY_CLASS.test(name)) { return false; }
	// Состояния и модификаторы попадают в карту вместе с базовым классом, отдельной строкой не нужны.
	return !name.startsWith('is-') && !name.startsWith('has-');
}

/**
 * CSS custom properties, объявленные (а не только использованные) в файле.
 *
 * Имя длиной в один символ (`--x`) — валидный CSS и встречается в сжатых сборках, поэтому нижней
 * границы длины здесь нет: отбрасывать валидное имя значит молча потерять токен, который проект
 * использует.
 */
function collectTokens(content: string): string[] {
	const out = new Set<string>();
	for (const match of content.matchAll(/(--[a-zA-Z0-9-_]{1,60})\s*:/g)) {
		out.add(match[1]);
	}
	return [...out];
}

/** Классы, объявленные в CSS-селекторах. */
function collectClasses(content: string): string[] {
	const out = new Set<string>();
	for (const match of content.matchAll(/(?:^|[\s,>+~{}])\.([a-zA-Z_][a-zA-Z0-9_-]{1,39})/g)) {
		if (isMeaningfulClass(match[1])) { out.add(`.${match[1]}`); }
	}
	return [...out];
}

/** Экспортированные React-компоненты: имя с заглавной буквы. */
function collectComponents(content: string): string[] {
	const out = new Set<string>();
	const patterns = [
		/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9_]*)/g,
		/export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*[:=]/g,
		/export\s+class\s+([A-Z][A-Za-z0-9_]*)/g,
	];
	for (const pattern of patterns) {
		for (const match of content.matchAll(pattern)) { out.add(match[1]); }
	}
	return [...out];
}

/** Как назвать слой по тому, что в файле нашлось и как файл называется. */
function layerNameFor(path: string, kind: 'tokens' | 'classes' | 'components'): string {
	const lower = path.toLowerCase();
	if (kind === 'tokens') { return 'Токены'; }
	if (kind === 'components') {
		if (lower.includes('/icons') || lower.includes('icon.')) { return 'Иконки'; }
		if (lower.includes('/ui') || lower.includes('/primitives')) { return 'Примитивы интерфейса'; }
		return 'Компоненты';
	}
	return 'Компоненты (CSS)';
}

/**
 * Собрать черновик карты.
 *
 * Файл попадает в карту, только если в нём нашлось что назвать: пустая строка «этот файл ничего не
 * объявляет» — это шум, из-за которого перестают читать всю таблицу.
 */
export function buildUiKitDraft(files: readonly UiKitSourceFile[], projectName: string): UiKitDraft {
	const layers: UiKitDraftLayer[] = [];
	const names = new Set<string>();

	for (const file of files) {
		const isStyle = /\.(css|scss|sass|less)$/i.test(file.path);
		const isScript = /\.(tsx|jsx|ts|js|vue|svelte)$/i.test(file.path);

		if (isStyle) {
			const tokens = collectTokens(file.content);
			if (tokens.length) {
				tokens.forEach(t => names.add(t));
				layers.push({ layer: layerNameFor(file.path, 'tokens'), file: file.path, contains: summarise(tokens) });
			}
			const classes = collectClasses(file.content);
			if (classes.length) {
				classes.forEach(c => names.add(c));
				layers.push({ layer: layerNameFor(file.path, 'classes'), file: file.path, contains: summarise(classes) });
			}
		} else if (isScript) {
			const components = collectComponents(file.content);
			if (components.length) {
				components.forEach(c => names.add(c));
				layers.push({ layer: layerNameFor(file.path, 'components'), file: file.path, contains: summarise(components) });
			}
		}
	}

	// Порядок слоёв — от «нельзя выдумывать» к «уже написано»: токены, классы, компоненты. Читающий
	// карту сверху вниз сначала узнаёт, из чего собирать, и только потом — что уже собрано. Внутри
	// слоя — по пути, чтобы повторный сбор давал тот же файл, а не перетасованный.
	const order: Record<string, number> = { 'Токены': 0, 'Компоненты (CSS)': 1, 'Примитивы интерфейса': 2, 'Иконки': 3, 'Компоненты': 4 };
	const sorted = [...layers].sort((a, b) =>
		(order[a.layer] ?? 9) - (order[b.layer] ?? 9) || a.file.localeCompare(b.file));
	return { layers: sorted, names: [...names], markdown: renderUiKitDraft(sorted, [...names], projectName) };
}

function summarise(items: readonly string[]): string {
	const head = items.slice(0, MAX_NAMES_PER_LAYER).map(i => `\`${i}\``).join(', ');
	return items.length > MAX_NAMES_PER_LAYER ? `${head} и ещё ${items.length - MAX_NAMES_PER_LAYER}` : head;
}

/**
 * Отрисовать карту.
 *
 * Пустой результат — не пустая таблица, а честная фраза: карта, состоящая из заголовков, выглядит
 * как работа, которой не было, и её принимают за факт «в проекте ничего нет».
 */
export function renderUiKitDraft(
	layers: readonly UiKitDraftLayer[],
	names: readonly string[],
	projectName: string,
): string {
	const header = `# Карта UI проекта «${projectName}»\n\n> Снята с кода. Читается ПЕРВОЙ, когда правится интерфейс: отвечает на вопрос «это уже есть?».\n> Правьте руками — снятое автоматически знает имена, но не знает, что из этого главное.\n`;
	if (layers.length === 0) {
		return `${header}\nВ просмотренных файлах не нашлось ни токенов, ни классов, ни экспортированных компонентов. Это не значит, что их нет: возможно, стили лежат вне обычных мест или собираются на лету. Впишите карту руками — пустая карта хуже её отсутствия.\n`;
	}
	const rows = layers.map(l => `| ${l.layer} | \`${l.file}\` | ${l.contains} |`).join('\n');
	const namesLine = names.length
		? `\n## 2. Имена, на которые ссылаться\n\nВ задаче называйте компонент дословно, а не описательно: «добавь ${names.find(n => /^[A-Z]/.test(n)) ?? names[0]}», а не «сделай красивее».\n`
		: '';
	return `${header}
## 1. Где что лежит

| Слой | Файл | Что внутри |
|---|---|---|
${rows}
${namesLine}
## 3. Правило источника правды

- Значение, которое повторяется, → выносится в **токен**.
- Разметка, которая повторяется, → выносится в **компонент**.
- Готовое не подходит — **расширяется существующее**, а не заводится второе рядом.

## 4. Do / Don't

- **Don't:** двойной отступ между соседними полосами одного цвета — воздух задаёт кто-то один.
- **Don't:** новая тень, радиус или цвет «под этот случай» — берите из токенов.
- **Do:** дополнять карту, когда модель ошиблась: не нашлось имени — значит его здесь не было.
`;
}
