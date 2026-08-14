/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Layout rules: geometry that the page produced, judged against how a reader moves through it.
 *
 * This is where the real defects live — clipped controls, content wider than its box, text under an
 * opaque layer. Two of them are ours by experience: a delete button sheared off inside a project row
 * and a specs pill cut by its container, both `overflow` + box-model, both shipped twice.
 */

import { DocumentSnapshot, ElementSnapshot, RuleFinding, Rule, isBodyText } from '../designSnapshot.js';
import { RULE } from '../ruleIds.js';

/** Beyond this the eye loses the line start on the way back. */
const MAX_LINE_LENGTH_CH = 95;
/** Apple/Google agree on ~44px as the smallest comfortable touch target. */
const MIN_TOUCH_TARGET_PX = 44;
/** Cards inside cards inside cards — the third level is where it becomes noise. */
const MAX_CARD_DEPTH = 2;
/** Overflow under this is rounding, not a defect. */
const OVERFLOW_TOLERANCE_PX = 2;
/** A clipped child has to stick out by more than a hairline to matter. */
const CLIP_TOLERANCE_PX = 2;
/** Share of an element's area that must be covered before we call the text occluded. */
const OCCLUSION_MIN_COVER = 0.6;
/** Identical siblings from this count on are a template rather than a coincidence. */
const IDENTICAL_CARDS_MIN = 3;
/** Sizes within this ratio count as "the same size" when comparing sibling cards. */
const SAME_SIZE_TOLERANCE = 0.08;
/** Gaps to sample before deciding a page has one rhythm and no other. */
const MONOTONOUS_MIN_GAPS = 6;
/** Share of gaps that must be the same value for the rhythm to read as monotonous. */
const MONOTONOUS_MIN_SHARE = 0.8;
/** Gaps are rounded to this before comparison: 23.5px and 24px are the same decision. */
const GAP_BUCKET_PX = 4;
/** A hero metric is a big number with a small caption under it. */
const METRIC_MIN_FONT_PX = 28;
const METRIC_CAPTION_MAX_FONT_PX = 16;
const METRIC_GROUP_MIN = 3;
/** A numbered section label is one or two digits set small next to a heading. */
const NUMBER_LABEL_MAX_FONT_PX = 15;
/** Columns whose heights differ by this much leave the shorter one looking abandoned. */
const COLUMN_IMBALANCE_RATIO = 2.2;
/** Below this width a "column" is a sidebar note, not a column. */
const COLUMN_MIN_WIDTH_PX = 200;
/** A heading needs more air above it than below: less than this ratio reads as crowding. */
const HEADING_SPACE_RATIO = 0.6;
/** Distance from a heading's top within which the previous block is "against" it. */
const HEADING_CROWD_GAP_PX = 10;
/** Cards flush to one edge of a horizontal scroller while their siblings have breathing room. */
const FLUSH_EDGE_MAX_PX = 1;
const FLUSH_SIBLING_MIN_GAP_PX = 8;

const right = (el: ElementSnapshot): number => el.leftPx + el.widthPx;
const bottom = (el: ElementSnapshot): number => el.topPx + el.heightPx;

const bySelector = (doc: DocumentSnapshot): Map<string, ElementSnapshot> => {
	const map = new Map<string, ElementSnapshot>();
	for (const el of doc.elements) {
		if (!map.has(el.selector)) {
			map.set(el.selector, el);
		}
	}
	return map;
};

const siblingGroups = (doc: DocumentSnapshot): Map<string, ElementSnapshot[]> => {
	const groups = new Map<string, ElementSnapshot[]>();
	for (const el of doc.elements) {
		if (!el.parentSelector) { continue; }
		const group = groups.get(el.parentSelector);
		if (group) { group.push(el); } else { groups.set(el.parentSelector, [el]); }
	}
	return groups;
};

const overlapArea = (a: ElementSnapshot, b: ElementSnapshot): number => {
	const width = Math.min(right(a), right(b)) - Math.max(a.leftPx, b.leftPx);
	const height = Math.min(bottom(a), bottom(b)) - Math.max(a.topPx, b.topPx);
	return width > 0 && height > 0 ? width * height : 0;
};

const ruleLineLength: Rule = doc => doc.elements
	.filter(isBodyText)
	.filter(el => {
		// ~0.5em per character is the usual average for proportional fonts.
		const approxCh = el.fontSizePx > 0 ? el.widthPx / (el.fontSizePx * 0.5) : 0;
		return approxCh > MAX_LINE_LENGTH_CH;
	})
	.map(el => ({
		rule: RULE.lineLength,
		severity: 'warning' as const,
		message: 'Строка текста длиннее 95 знаков',
		why: 'На длинной строке читатель промахивается мимо начала следующей.',
		selector: el.selector,
		evidence: `ширина ${el.widthPx.toFixed(0)}px при font-size ${el.fontSizePx}px`,
	}));

const ruleTouchTarget: Rule = doc => doc.elements
	.filter(el => el.interactive && el.widthPx > 0 && el.heightPx > 0)
	.filter(el => el.heightPx < MIN_TOUCH_TARGET_PX && el.widthPx < MIN_TOUCH_TARGET_PX)
	.map(el => ({
		rule: RULE.crampedTarget,
		severity: 'warning' as const,
		message: `Кликабельная область ${el.widthPx.toFixed(0)}×${el.heightPx.toFixed(0)}px`,
		why: 'Меньше 44px пальцем промахиваются — на телефоне это заметно сразу.',
		selector: el.selector,
		evidence: `${el.widthPx.toFixed(0)}×${el.heightPx.toFixed(0)}px`,
	}));

const ruleNestedCards: Rule = doc => doc.elements
	.filter(el => el.cardDepth > MAX_CARD_DEPTH)
	.map(el => ({
		rule: RULE.nestedCards,
		severity: 'info' as const,
		message: `Карточка вложена на ${el.cardDepth}-й уровень`,
		why: 'Рамка в рамке в рамке не добавляет структуры — она добавляет шум.',
		selector: el.selector,
		evidence: `глубина карточек: ${el.cardDepth}`,
	}));

/** Content wider than the box holding it: the classic shipped-and-noticed-later defect. */
const ruleContentOverflow: Rule = doc => doc.elements
	.filter(el => el.clientWidthPx > 0 && el.overflowX !== 'visible')
	.filter(el => el.scrollWidthPx - el.clientWidthPx > OVERFLOW_TOLERANCE_PX)
	// A scroller is supposed to overflow; only clipping without a way to reach the rest is a defect.
	.filter(el => el.overflowX === 'hidden' || el.overflowX === 'clip')
	.map(el => ({
		rule: RULE.contentOverflow,
		severity: 'error' as const,
		message: `Содержимое шире контейнера на ${(el.scrollWidthPx - el.clientWidthPx).toFixed(0)}px и обрезано`,
		why: 'Обрезанный контент нельзя ни прочитать, ни докрутить — часть интерфейса просто недоступна.',
		selector: el.selector,
		evidence: `scrollWidth ${el.scrollWidthPx.toFixed(0)}px против clientWidth ${el.clientWidthPx.toFixed(0)}px, overflow-x: ${el.overflowX}`,
	}));

/** The page itself wider than the viewport — the horizontal scrollbar nobody wanted. */
const rulePageOverflow: Rule = doc => {
	const scroll = doc.documentScrollWidthPx ?? 0;
	if (!scroll || !doc.viewportWidthPx || scroll - doc.viewportWidthPx <= OVERFLOW_TOLERANCE_PX) {
		return [];
	}
	// Which element sticks out is more useful than the fact that something does.
	const culprit = doc.elements
		.filter(el => right(el) - doc.viewportWidthPx > OVERFLOW_TOLERANCE_PX)
		.sort((a, b) => right(b) - right(a))[0];
	return [{
		rule: RULE.pageOverflow,
		severity: 'error',
		message: `Страница шире окна на ${(scroll - doc.viewportWidthPx).toFixed(0)}px`,
		why: 'Горизонтальная прокрутка страницы — всегда дефект вёрстки, и на телефоне она режет правый край.',
		selector: culprit?.selector ?? 'body',
		evidence: `scrollWidth документа ${scroll.toFixed(0)}px при окне ${doc.viewportWidthPx}px`
			+ (culprit ? `; дальше всех уходит ${culprit.selector} (до ${right(culprit).toFixed(0)}px)` : ''),
	}];
};

/**
 * An absolutely-positioned child sheared off by a clipping ancestor.
 *
 * Ours twice over: the delete button in a project row and the specs pill, both cut by a container
 * that clipped what the box model had already pushed outside it. A tooltip or a badge that leaves
 * its parent is invisible, and nothing in the source looks wrong.
 */
const ruleClippedPositionedChild: Rule = doc => {
	const parents = bySelector(doc);
	const findings: RuleFinding[] = [];
	for (const el of doc.elements) {
		if (el.position !== 'absolute' && el.position !== 'fixed') { continue; }
		const parent = parents.get(el.parentSelector);
		if (!parent) { continue; }
		const clipsX = parent.overflowX === 'hidden' || parent.overflowX === 'clip';
		const clipsY = parent.overflowY === 'hidden' || parent.overflowY === 'clip';
		if (!clipsX && !clipsY) { continue; }
		const outLeft = clipsX ? parent.leftPx - el.leftPx : 0;
		const outRight = clipsX ? right(el) - right(parent) : 0;
		const outTop = clipsY ? parent.topPx - el.topPx : 0;
		const outBottom = clipsY ? bottom(el) - bottom(parent) : 0;
		const worst = Math.max(outLeft, outRight, outTop, outBottom);
		if (worst <= CLIP_TOLERANCE_PX) { continue; }
		const side = worst === outRight ? 'справа' : worst === outLeft ? 'слева' : worst === outBottom ? 'снизу' : 'сверху';
		findings.push({
			rule: RULE.clippedPositionedChild,
			severity: 'error',
			message: `Элемент выходит за обрезающий контейнер на ${worst.toFixed(0)}px ${side}`,
			why: 'Контейнер с overflow: hidden срезает то, что позиционированный ребёнок вынес за его край — в исходнике при этом всё выглядит правильно.',
			selector: el.selector,
			evidence: `${el.selector} (${el.position}) против ${parent.selector} (overflow ${parent.overflowX}/${parent.overflowY})`,
		});
	}
	return findings;
};

/**
 * Родство внутри снимка.
 *
 * Считается по `parentId` — числовой связи, которую проставляет сборщик. По селекторам родство не
 * восстанавливается: предок может быть записан от `body` (`body > div.app`), а потомок — от другого
 * узла, и общего префикса у них нет. Снимки прежних сборщиков поля не несут, и для них остаётся
 * прежняя догадка по строкам: без неё правило начало бы ругаться на всё подряд.
 */
function isAncestorOf(doc: DocumentSnapshot, ancestor: ElementSnapshot, descendant: ElementSnapshot, indexOf: ReadonlyMap<ElementSnapshot, number>): boolean {
	if (descendant.parentId === undefined) {
		return ancestor.selector === descendant.parentSelector || descendant.selector.startsWith(ancestor.selector);
	}
	const ancestorIndex = indexOf.get(ancestor);
	if (ancestorIndex === undefined) { return false; }
	// Подъём ограничен длиной списка: битый снимок с закольцованными ссылками не должен вешать разбор.
	let current: number | undefined = descendant.parentId;
	for (let step = 0; step <= doc.elements.length && current !== undefined && current >= 0; step++) {
		if (current === ancestorIndex) { return true; }
		current = doc.elements[current]?.parentId;
	}
	return false;
}

/** Text under an opaque layer: readable in the DOM, gone on screen. */
const ruleOccludedText: Rule = doc => {
	const findings: RuleFinding[] = [];
	const texts = doc.elements.filter(el => el.text.length >= 4 && el.widthPx > 0 && el.heightPx > 0);
	const covers = doc.elements.filter(el => el.ownBackgroundAlpha >= 0.9 && el.position !== 'static');
	const indexOf = new Map(doc.elements.map((el, index) => [el, index] as const));
	for (const text of texts) {
		const area = text.widthPx * text.heightPx;
		for (const cover of covers) {
			// Собственный предок перекрывает потомка по площади всегда — это вложенность, а не слой
			// поверх. Фон панели, обёртка страницы и корень приложения иначе давали бы ошибку на
			// каждой строке текста внутри них.
			if (cover === text || isAncestorOf(doc, cover, text, indexOf)) { continue; }
			if (cover.zIndex < text.zIndex) { continue; }
			if (overlapArea(text, cover) / area < OCCLUSION_MIN_COVER) { continue; }
			findings.push({
				rule: RULE.occludedText,
				severity: 'error',
				message: `Текст «${text.text.slice(0, 30)}» перекрыт непрозрачным слоем`,
				why: 'Читатель видит не текст, а то, что лежит поверх него; в разметке при этом всё на месте.',
				selector: text.selector,
				evidence: `перекрыт ${cover.selector} (z-index ${cover.zIndex}) на ${(100 * overlapArea(text, cover) / area).toFixed(0)}%`,
			});
			break;
		}
	}
	return findings;
};

/** Identical icon+heading+text cards repeated across a grid. */
const ruleIdenticalCards: Rule = doc => {
	const findings: RuleFinding[] = [];
	for (const [parent, children] of siblingGroups(doc)) {
		const byShape = new Map<string, ElementSnapshot[]>();
		for (const child of children) {
			if (child.childTags.length < 2 || child.widthPx < 80) { continue; }
			const key = child.childTags.join('/') + '|' + Math.round(child.widthPx / 10);
			const bucket = byShape.get(key);
			if (bucket) { bucket.push(child); } else { byShape.set(key, [child]); }
		}
		for (const [shape, bucket] of byShape) {
			if (bucket.length < IDENTICAL_CARDS_MIN) { continue; }
			const heights = bucket.map(card => card.heightPx);
			const spread = (Math.max(...heights) - Math.min(...heights)) / Math.max(1, Math.max(...heights));
			if (spread > SAME_SIZE_TOLERANCE) { continue; }
			findings.push({
				rule: RULE.identicalCards,
				severity: 'info',
				message: `${bucket.length} карточек одинаковой формы подряд`,
				why: 'Одинаковые карточки читаются как забор: глазу не за что зацепиться, и ни одна не важнее другой.',
				selector: parent,
				evidence: `${bucket.length} × «${shape.split('|')[0]}», высоты совпадают`,
			});
		}
	}
	return findings;
};

/** One spacing value everywhere: no rhythm, so nothing groups and nothing separates. */
const ruleMonotonousSpacing: Rule = doc => {
	const gaps: number[] = [];
	for (const [, children] of siblingGroups(doc)) {
		const stacked = [...children]
			.filter(child => child.heightPx > 8)
			.sort((a, b) => a.topPx - b.topPx);
		for (let i = 0; i + 1 < stacked.length; i++) {
			const gap = stacked[i + 1].topPx - bottom(stacked[i]);
			if (gap >= 4 && gap <= 200) {
				gaps.push(Math.round(gap / GAP_BUCKET_PX) * GAP_BUCKET_PX);
			}
		}
	}
	if (gaps.length < MONOTONOUS_MIN_GAPS) { return []; }
	const counts = new Map<number, number>();
	for (const gap of gaps) { counts.set(gap, (counts.get(gap) ?? 0) + 1); }
	const [value, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
	if (count / gaps.length < MONOTONOUS_MIN_SHARE) { return []; }
	return [{
		rule: RULE.monotonousSpacing,
		severity: 'info',
		message: `Один и тот же вертикальный шаг ${value}px в ${count} из ${gaps.length} промежутков`,
		why: 'Ритм отступов и есть структура: плотно внутри группы, щедро между группами. Одно значение везде эту структуру стирает.',
		selector: 'body',
		evidence: `${count}/${gaps.length} промежутков = ${value}px`,
	}];
};


/**
 * Один ли это фон визуально.
 *
 * Сравнение с допуском, а не точное: полосы часто отличаются на единицу канала из-за
 * полупрозрачного слоя поверх одинаковой подложки, и такая разница глазу недоступна — граница
 * между полосами всё равно не читается, а значит поля всё равно складываются.
 */
const sameColor = (a: readonly [number, number, number], b: readonly [number, number, number]): boolean =>
	Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2 && Math.abs(a[2] - b[2]) <= 2;

/**
 * Двойной отступ между соседними полосами одного цвета.
 *
 * Классический промах непрофессионала, и модель повторяет его чаще всего: у верхней секции есть
 * нижний внутренний отступ, у нижней — верхний, оба щедрые. Пока фон у секций разный, это два
 * поля двух разных плоскостей и читается нормально. Как только фон совпал, граница между ними
 * исчезает — и на странице появляется провал в два раза шире задуманного, которого никто не
 * закладывал: воздух задаёт кто-то ОДИН из соседей.
 *
 * Считается по `padding`, а не по `margin`, намеренно: вертикальные margin соседей CSS схлопывает
 * в максимум, поэтому «двойного» из них не получается вовсе — а padding складывается всегда.
 */
const ruleDoubleGap: Rule = doc => {
	const MIN_SIDE_PX = 24;       // ниже этого — обычный внутренний отступ, а не полоса воздуха
	const MIN_TOTAL_PX = 96;      // суммарный провал, с которого разрыв виден глазом
	const findings: RuleFinding[] = [];
	const byParent = new Map<string, ElementSnapshot[]>();
	for (const node of doc.elements) {
		const siblings = byParent.get(node.parentSelector);
		if (siblings) { siblings.push(node); } else { byParent.set(node.parentSelector, [node]); }
	}
	for (const siblings of byParent.values()) {
		if (siblings.length < 2) { continue; }
		const ordered = [...siblings].sort((a, b) => a.topPx - b.topPx);
		for (let i = 0; i < ordered.length - 1; i++) {
			const upper = ordered[i];
			const lower = ordered[i + 1];
			// Только вертикальные соседи: колонки рядом друг с другом к этому правилу не относятся.
			const upperBottom = upper.topPx + upper.heightPx;
			if (Math.abs(lower.topPx - upperBottom) > 2) { continue; }
			if (upper.widthPx < 200 || lower.widthPx < 200) { continue; }
			const bottom = upper.paddingPx.bottom;
			const top = lower.paddingPx.top;
			if (bottom < MIN_SIDE_PX || top < MIN_SIDE_PX || bottom + top < MIN_TOTAL_PX) { continue; }
			// Разный фон = видимая граница, и два поля законны.
			if (!sameColor(upper.backgroundColor, lower.backgroundColor)) { continue; }
			findings.push({
				rule: RULE.doubleGap,
				severity: 'warning',
				message: `Двойной отступ между соседними полосами одного цвета: ${bottom}px снизу и ${top}px сверху`,
				why: 'Границы между полосами нет — фон один, поэтому поля складываются в провал вдвое шире задуманного. Воздух между соседями задаёт кто-то один из них.',
				selector: lower.selector,
				evidence: `${upper.selector} padding-bottom ${bottom}px + ${lower.selector} padding-top ${top}px = ${bottom + top}px`,
			});
		}
	}
	return findings;
};

/** Big number, small caption, three of them in a row, gradient optional. */
const ruleHeroMetrics: Rule = doc => {
	const findings: RuleFinding[] = [];
	const isNumber = (text: string): boolean => /^[+\-]?[\d\s.,]{1,9}\s*(?:%|[kкКmМbБ]|млн|тыс|шт|\+)?$/.test(text.trim()) && /\d/.test(text);
	for (const [parent, children] of siblingGroups(doc)) {
		const metrics = children.filter(child =>
			child.fontSizePx >= METRIC_MIN_FONT_PX
			&& isNumber(child.text)
			&& children.some(caption =>
				caption !== child
				&& caption.fontSizePx > 0 && caption.fontSizePx <= METRIC_CAPTION_MAX_FONT_PX
				&& caption.text.length > 0
				&& Math.abs(caption.leftPx - child.leftPx) < child.widthPx
				&& caption.topPx >= bottom(child) - 4));
		if (metrics.length >= METRIC_GROUP_MIN) {
			findings.push({
				rule: RULE.heroMetrics,
				severity: 'info',
				message: `Три метрики «большое число + подпись» в одном блоке`,
				why: 'Тройка крупных цифр с подписями — готовый шаблон героя: он выглядит убедительно независимо от того, что за числа.',
				selector: parent,
				evidence: metrics.slice(0, 3).map(metric => `${metric.text.trim()} (${metric.fontSizePx.toFixed(0)}px)`).join(', '),
			});
		}
	}
	return findings;
};

/** Tiny numbers beside headings, imitating editorial structure. */
const ruleNumberedSectionLabels: Rule = doc => {
	const groups = siblingGroups(doc);
	const findings: RuleFinding[] = [];
	for (const [, children] of groups) {
		const labels = children.filter(child =>
			child.fontSizePx > 0 && child.fontSizePx <= NUMBER_LABEL_MAX_FONT_PX
			&& /^(?:0\d|\d{1,2})(?:\s*[.—–-])?$/.test(child.text.trim())
			&& children.some(heading => /^h[1-4]$/.test(heading.tag) && Math.abs(heading.topPx - child.topPx) < 40));
		for (const label of labels.slice(0, 1)) {
			findings.push({
				rule: RULE.numberedSectionLabel,
				severity: 'info',
				message: `Номер «${label.text.trim()}» рядом с заголовком`,
				why: 'Мелкие номера у заголовков имитируют редакторскую структуру, не добавляя её: порядок и без них виден.',
				selector: label.selector,
				evidence: `${label.text.trim()} при ${label.fontSizePx.toFixed(0)}px`,
			});
		}
	}
	return findings;
};

/** Two columns side by side, one twice the other: the short one looks unfinished. */
const ruleColumnImbalance: Rule = doc => {
	const findings: RuleFinding[] = [];
	for (const [parent, children] of siblingGroups(doc)) {
		const columns = children.filter(child => child.widthPx >= COLUMN_MIN_WIDTH_PX && child.heightPx > 40);
		for (let i = 0; i < columns.length; i++) {
			for (let j = i + 1; j < columns.length; j++) {
				const a = columns[i], b = columns[j];
				const sideBySide = Math.min(right(a), right(b)) <= Math.max(a.leftPx, b.leftPx)
					&& Math.min(bottom(a), bottom(b)) > Math.max(a.topPx, b.topPx);
				if (!sideBySide) { continue; }
				const [tall, short] = a.heightPx >= b.heightPx ? [a, b] : [b, a];
				if (tall.heightPx / Math.max(1, short.heightPx) < COLUMN_IMBALANCE_RATIO) { continue; }
				findings.push({
					rule: RULE.columnImbalance,
					severity: 'info',
					message: `Соседние колонки отличаются по высоте в ${(tall.heightPx / Math.max(1, short.heightPx)).toFixed(1)} раза`,
					why: 'Рядом с высокой колонкой короткая читается как незаполненная: либо уравнять, либо развести по вертикали.',
					selector: parent,
					evidence: `${tall.heightPx.toFixed(0)}px против ${short.heightPx.toFixed(0)}px`,
				});
				return findings.slice(0, 3);
			}
		}
	}
	return findings;
};

/** A heading pressed against the block above it: it labels the wrong side. */
const ruleHeadingCrowded: Rule = doc => {
	const parents = siblingGroups(doc);
	const findings: RuleFinding[] = [];
	for (const [, children] of parents) {
		for (const heading of children) {
			if (!/^h[2-4]$/.test(heading.tag) || heading.marginPx.bottom <= 0) { continue; }
			if (heading.marginPx.top >= heading.marginPx.bottom * HEADING_SPACE_RATIO) { continue; }
			const previous = children
				.filter(child => child !== heading && bottom(child) <= heading.topPx + 1)
				.sort((a, b) => bottom(b) - bottom(a))[0];
			if (!previous || heading.topPx - bottom(previous) > HEADING_CROWD_GAP_PX) { continue; }
			findings.push({
				rule: RULE.headingCrowded,
				severity: 'warning',
				message: `Заголовок «${heading.text.slice(0, 30)}» прижат к предыдущему блоку`,
				why: 'Заголовок должен принадлежать тому, что под ним: сверху нужно больше воздуха, чем снизу, иначе он читается как подпись к предыдущему.',
				selector: heading.selector,
				evidence: `margin-top ${heading.marginPx.top}px против margin-bottom ${heading.marginPx.bottom}px, зазор ${(heading.topPx - bottom(previous)).toFixed(0)}px`,
			});
		}
	}
	return findings;
};

/** First card flush to the scroller edge while its siblings have gaps. */
const ruleFlushToScrollerEdge: Rule = doc => {
	const parents = bySelector(doc);
	const findings: RuleFinding[] = [];
	for (const [parentSelector, children] of siblingGroups(doc)) {
		const parent = parents.get(parentSelector);
		if (!parent || (parent.overflowX !== 'auto' && parent.overflowX !== 'scroll')) { continue; }
		const row = [...children].filter(child => child.widthPx > 40).sort((a, b) => a.leftPx - b.leftPx);
		if (row.length < 2) { continue; }
		const leadingGap = row[0].leftPx - parent.leftPx;
		const betweenGap = row[1].leftPx - right(row[0]);
		if (leadingGap <= FLUSH_EDGE_MAX_PX && betweenGap >= FLUSH_SIBLING_MIN_GAP_PX) {
			findings.push({
				rule: RULE.flushToScrollerEdge,
				severity: 'warning',
				message: 'Первая карточка стоит заподлицо с краем прокрутки',
				why: 'Отступы с двух сторон должны совпадать, иначе край выглядит обрезанным, а не начатым.',
				selector: row[0].selector,
				evidence: `слева ${leadingGap.toFixed(0)}px, между карточками ${betweenGap.toFixed(0)}px`,
			});
		}
	}
	return findings;
};

export const LAYOUT_RULES: readonly Rule[] = [
	ruleLineLength,
	ruleTouchTarget,
	ruleNestedCards,
	ruleContentOverflow,
	rulePageOverflow,
	ruleClippedPositionedChild,
	ruleOccludedText,
	ruleIdenticalCards,
	ruleMonotonousSpacing,
	ruleDoubleGap,
	ruleHeroMetrics,
	ruleNumberedSectionLabels,
	ruleColumnImbalance,
	ruleHeadingCrowded,
	ruleFlushToScrollerEdge,
];
