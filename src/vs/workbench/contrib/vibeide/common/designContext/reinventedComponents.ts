/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * «Модель завела новый компонент вместо существующего» — проверка на другом входе.
 *
 * Детектор смотрит на готовую страницу и не может этого поймать по построению: класс `.hero-card`
 * на снимке неотличим от `.card`, написанного год назад, — оба просто классы с одинаковым
 * поведением. Единственное место, где видно РАЗНИЦУ между «взял готовое» и «сделал своё», — сам
 * текст правки: там видно, что имя объявляется впервые.
 *
 * Поэтому здесь на вход идёт добавленный код и карта UI, а не снимок.
 *
 * Главный риск такой проверки — ложная тревога. Агент, которого одёргивают на законных именах,
 * научится игнорировать предупреждение целиком, и оно перестанет работать там, где оно право.
 * Поэтому критерий намеренно узкий: совпадение ОСНОВЫ имени после нормализации. `.card-wrapper`
 * при существующем `.card` — тревога; `.pricing-table` при существующем `.card` — молчание, это
 * действительно новый компонент, а не второй вариант старого.
 */

/** Что нашлось: объявленное имя и то, на что оно похоже из уже существующих. */
export interface ReinventedName {
	/** Имя, объявленное в правке. */
	readonly declared: string;
	/** Существующее имя из карты, основа которого совпала. */
	readonly existing: string;
}

/**
 * Привести имя к основе, по которой сравниваются «то же самое, но своё».
 *
 * Убирается всё, чем обычно отличают вариант от базы: ведущая точка, регистр, разделители, а также
 * типовые обвязки (`wrapper`, `container`, `new`, `custom`, `v2`). Именно ими называют второй
 * экземпляр того же компонента, когда не нашли первый.
 */
export function normaliseComponentName(name: string): string {
	const bare = name.replace(/^[.#]/, '');
	// BEM-модификатор — это состояние базового класса, а не новое имя: `.btn--ghost` → `btn`.
	const withoutModifier = bare.split('--')[0].split('__')[0];
	// Границы слов ищутся ДО приведения к нижнему регистру: в `CardContainer` разделяет именно
	// заглавная буква, и `toLowerCase()` перед этим шагом стирает единственный признак границы —
	// имя схлопывается в `cardcontainer` и перестаёт совпадать с `card`.
	const words = withoutModifier
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.toLowerCase()
		.split(/[-_\s]+/)
		.filter(Boolean)
		.filter(word => !NOISE_WORDS.has(word));
	return words.join('');
}

/** Слова, которыми называют «то же самое, но моё». Не несут смысла компонента. */
const NOISE_WORDS: ReadonlySet<string> = new Set([
	'wrapper', 'wrap', 'container', 'inner', 'outer', 'box', 'block', 'element',
	'new', 'custom', 'my', 'alt', 'v2', 'v3', '2', '3', 'component', 'styled',
]);

/** Имена, объявленные в добавленном коде: CSS-классы и экспортированные компоненты. */
export function collectDeclaredNames(addedCode: string): string[] {
	const out = new Set<string>();
	// CSS: имя объявляется, когда за селектором идёт блок правил.
	for (const match of addedCode.matchAll(/(?:^|[\s,>+~])\.([a-zA-Z_][a-zA-Z0-9_-]{1,39})(?=[^;{}]*\{)/gm)) {
		out.add(`.${match[1]}`);
	}
	// React/Vue/Svelte: экспортированный компонент с заглавной буквы.
	for (const pattern of [
		/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9_]*)/g,
		/export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*[:=]/g,
		/export\s+class\s+([A-Z][A-Za-z0-9_]*)/g,
	]) {
		for (const match of addedCode.matchAll(pattern)) { out.add(match[1]); }
	}
	return [...out];
}

/**
 * Что из объявленного в правке дублирует уже существующее.
 *
 * Точное совпадение имени НЕ находка: это правка существующего компонента, ровно то, чего мы и
 * хотим. Находка — когда основа совпала, а имя другое.
 */
export function findReinventedComponents(
	addedCode: string,
	existingNames: readonly string[],
): ReinventedName[] {
	if (!addedCode.trim() || existingNames.length === 0) { return []; }

	// Основа → первое существующее имя с такой основой. Первое, а не все: сообщение должно назвать
	// один конкретный компонент, который надо взять, иначе оно превращается в список на подумать.
	const byBase = new Map<string, string>();
	const exact = new Set<string>();
	for (const name of existingNames) {
		exact.add(name.toLowerCase());
		const base = normaliseComponentName(name);
		// Односимвольная основа ничего не различает: под неё попадёт половина проекта.
		if (base.length > 2 && !byBase.has(base)) { byBase.set(base, name); }
	}

	const found: ReinventedName[] = [];
	const seen = new Set<string>();
	for (const declared of collectDeclaredNames(addedCode)) {
		if (exact.has(declared.toLowerCase())) { continue; } // правка существующего — это норма
		const base = normaliseComponentName(declared);
		const existing = byBase.get(base);
		if (!existing || seen.has(declared)) { continue; }
		// `.btn--ghost` при существующем `.btn` — это состояние базового класса, объявлять его
		// нормально и нужно. Отличается от варианта тем, что до разделителя стоит ровно базовое имя.
		const declaredRoot = declared.replace(/^[.#]/, '').split(/--|__/)[0].toLowerCase();
		if (declaredRoot === existing.replace(/^[.#]/, '').toLowerCase()) { continue; }
		seen.add(declared);
		found.push({ declared, existing });
	}
	return found;
}

/** Текст предупреждения агенту. Пусто, когда находок нет — молчание тоже ответ. */
export function renderReinventedWarning(found: readonly ReinventedName[], mapPath: string): string {
	if (found.length === 0) { return ''; }
	const list = found.map(f => `• \`${f.declared}\` — в проекте уже есть \`${f.existing}\``).join('\n');
	return `⚠️ Похоже, интерфейсный элемент заводится заново вместо существующего:\n\n${list}\n\n`
		+ `Возьмите существующий или расширьте его. Если новый компонент действительно нужен — так и скажите в ответе, `
		+ `и впишите его в карту UI (${mapPath}), чтобы следующий раз его нашли.`;
}

/**
 * Выбрать из блоков SEARCH/REPLACE только то, что правка ДОБАВЛЯЕТ.
 *
 * Половина `ORIGINAL` — это существующий код: объявления в ней принадлежат тому, что уже написано,
 * и считать их «изобретением заново» значит ругаться на каждую правку рядом с чужим классом.
 * Берётся только половина `UPDATED`.
 *
 * Незакрытый блок (модель оборвала вывод) отдаёт то, что успело прийти после разделителя: правка
 * с таким блоком всё равно не применится, но и терять уже прочитанное незачем.
 */
export function extractReplaceSides(searchReplaceBlocks: string): string {
	const parts: string[] = [];
	// Маркеры продублированы здесь литералами намеренно: модуль лежит в common и не должен тащить
	// за собой промптовый слой ради трёх строк — а сами маркеры не менялись ни разу с их появления.
	const re = /^=======$([\s\S]*?)(?=^>>>>>>> UPDATED$|^<<<<<<< ORIGINAL$|$(?![\s\S]))/gm;
	for (const match of searchReplaceBlocks.matchAll(re)) {
		parts.push(match[1]);
	}
	return parts.join('\n');
}
