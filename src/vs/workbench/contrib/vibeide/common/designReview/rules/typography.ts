/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Type rules: what the page set, and what it says about who set it. */

import { ElementSnapshot, RuleFinding, Rule, isBodyText, looksSerif, primaryFamily } from '../designSnapshot.js';
import { RULE } from '../ruleIds.js';

/** Below this, body copy stops being comfortable on a laptop screen. */
const MIN_BODY_FONT_PX = 12;
/** Interactive labels need more than body copy: the user aims at them. */
const MIN_INTERACTIVE_FONT_PX = 13;
/** Tighter than this and descenders start colliding on multi-line copy. */
const MIN_BODY_LINE_HEIGHT_RATIO = 1.25;
/** Text this long in all-caps stops being readable. */
const MAX_ALL_CAPS_CHARS = 40;
/** Letter-spacing outside this band is a "designed" look applied without reason. */
const MAX_TRACKING_RATIO = 0.2;
const MIN_TRACKING_RATIO = -0.06;
/** An h1 larger than this share of the viewport shouts rather than leads. */
const MAX_H1_VIEWPORT_RATIO = 0.13;
/** Headline levels closer than this in size do not read as a hierarchy. */
const MIN_HEADING_STEP_RATIO = 1.08;
/** A kicker is small, tracked, upper-case and sits directly above something much bigger. */
const KICKER_MAX_FONT_PX = 15;
const KICKER_MIN_TRACKING_RATIO = 0.04;
const KICKER_MIN_SIZE_JUMP = 1.6;
/** Vertical gap within which two elements read as one stacked unit. */
const STACK_GAP_PX = 24;
/** An icon tile is small, square-ish and rounded. */
const ICON_TILE_MAX_PX = 72;
const ICON_TILE_MIN_RADIUS_PX = 6;
/** A display headline this large should not be carrying a whole sentence. */
const DISPLAY_FONT_PX = 34;
/** Words above which a display headline is a paragraph wearing a headline's clothes. */
const MAX_DISPLAY_WORDS = 12;
/** Families that arrive with the template rather than with a decision. */
const OVERUSED_FAMILIES = ['inter', 'geist', 'space grotesk', 'instrument serif', 'plus jakarta sans', 'dm sans'];

const ratioTracking = (el: ElementSnapshot): number => el.fontSizePx > 0 ? el.letterSpacingPx / el.fontSizePx : 0;

/** Elements that sit directly above `el` in the same parent, close enough to read as one unit. */
const stackedBelow = (doc: { elements: readonly ElementSnapshot[] }, el: ElementSnapshot): ElementSnapshot[] =>
	doc.elements.filter(other =>
		other !== el
		&& other.parentSelector === el.parentSelector
		&& other.topPx >= el.topPx + el.heightPx - 2
		&& other.topPx - (el.topPx + el.heightPx) <= STACK_GAP_PX);

const ruleTinyText: Rule = doc => doc.elements
	.filter(el => el.text.length > 0 && el.fontSizePx > 0 && el.fontSizePx < MIN_BODY_FONT_PX && !el.interactive)
	.map(el => ({
		rule: RULE.tinyText,
		severity: 'warning' as const,
		message: `Текст ${el.fontSizePx.toFixed(0)}px — мельче читаемого минимума`,
		why: 'Ниже 12px текст перестают читать и начинают угадывать.',
		selector: el.selector,
		evidence: `font-size: ${el.fontSizePx}px`,
	}));

const ruleUndersizedUiText: Rule = doc => doc.elements
	.filter(el => el.interactive && el.text.length > 0 && el.fontSizePx > 0 && el.fontSizePx < MIN_INTERACTIVE_FONT_PX)
	.map(el => ({
		rule: RULE.undersizedUiText,
		severity: 'warning' as const,
		message: `Подпись интерактивного элемента ${el.fontSizePx.toFixed(0)}px`,
		why: 'В кнопку целятся — её подпись должна читаться быстрее, чем основной текст, а не медленнее.',
		selector: el.selector,
		evidence: `font-size: ${el.fontSizePx}px`,
	}));

const ruleTightLeading: Rule = doc => doc.elements
	.filter(isBodyText)
	.filter(el => el.fontSizePx > 0 && el.lineHeightPx > 0 && el.lineHeightPx / el.fontSizePx < MIN_BODY_LINE_HEIGHT_RATIO)
	.map(el => ({
		rule: RULE.tightLeading,
		severity: 'warning' as const,
		message: `Межстрочный интервал ${(el.lineHeightPx / el.fontSizePx).toFixed(2)} — строки слипаются`,
		why: 'На абзаце в несколько строк глаз теряет, куда возвращаться.',
		selector: el.selector,
		evidence: `line-height: ${el.lineHeightPx}px при font-size: ${el.fontSizePx}px`,
	}));

const ruleAllCapsBody: Rule = doc => doc.elements
	.filter(el => el.textTransform === 'uppercase' && el.text.length > MAX_ALL_CAPS_CHARS)
	.map(el => ({
		rule: RULE.allCapsBody,
		severity: 'warning' as const,
		message: `Капслок на ${el.text.length} знаках`,
		why: 'Прописные лишают слова силуэта — длинный текст в них читается по буквам.',
		selector: el.selector,
		evidence: `text-transform: uppercase, длина ${el.text.length}`,
	}));

const ruleTracking: Rule = doc => doc.elements
	.filter(el => el.text.length > 0 && el.fontSizePx > 0)
	.map(el => ({ el, ratio: ratioTracking(el) }))
	.filter(({ ratio, el }) => (ratio > MAX_TRACKING_RATIO || ratio < MIN_TRACKING_RATIO) && el.text.length >= 12)
	.map(({ el, ratio }) => ({
		rule: ratio > 0 ? RULE.wideTracking : RULE.extremeNegativeTracking,
		severity: 'info' as const,
		message: ratio > 0
			? `Разрядка ${(ratio * 100).toFixed(0)}% от кегля`
			: `Отрицательный трекинг ${(ratio * 100).toFixed(0)}% — буквы наезжают`,
		why: 'Трекинг настраивают под конкретный кегль и гарнитуру; ровное значение «для красоты» видно сразу.',
		selector: el.selector,
		evidence: `letter-spacing: ${el.letterSpacingPx}px при ${el.fontSizePx}px`,
	}));

const ruleFlatHierarchy: Rule = doc => {
	const levels = new Map<string, number>();
	for (const heading of doc.headings) {
		const current = levels.get(heading.tag);
		if (current === undefined || heading.fontSizePx > current) { levels.set(heading.tag, heading.fontSizePx); }
	}
	const findings: RuleFinding[] = [];
	const ordered = ['h1', 'h2', 'h3', 'h4'].filter(tag => levels.has(tag));
	for (let i = 0; i + 1 < ordered.length; i++) {
		const bigger = levels.get(ordered[i])!;
		const smaller = levels.get(ordered[i + 1])!;
		if (smaller > 0 && bigger / smaller < MIN_HEADING_STEP_RATIO) {
			findings.push({
				rule: RULE.flatTypeHierarchy,
				severity: 'warning',
				message: `${ordered[i]} и ${ordered[i + 1]} почти одного размера`,
				why: 'Если уровни не отличаются на глаз, структура текста существует только в разметке.',
				selector: ordered[i + 1],
				evidence: `${bigger}px против ${smaller}px`,
			});
		}
	}
	return findings;
};

const ruleSkippedHeading: Rule = doc => {
	const findings: RuleFinding[] = [];
	let previous = 0;
	for (const heading of doc.headings) {
		const level = Number(heading.tag.slice(1));
		if (previous > 0 && level > previous + 1) {
			findings.push({
				rule: RULE.skippedHeading,
				severity: 'warning',
				message: `${heading.tag} идёт сразу после h${previous}`,
				why: 'Пропуск уровня ломает оглавление для скринридера — он читает структуру, а не размеры.',
				selector: heading.tag,
				evidence: `h${previous} → ${heading.tag}: «${heading.text.slice(0, 40)}»`,
			});
		}
		previous = level;
	}
	return findings;
};

const ruleOversizedH1: Rule = doc => doc.elements
	.filter(el => el.tag === 'h1' && doc.viewportWidthPx > 0)
	.filter(el => el.fontSizePx / doc.viewportWidthPx > MAX_H1_VIEWPORT_RATIO)
	.map(el => ({
		rule: RULE.oversizedH1,
		severity: 'info' as const,
		message: `Заголовок ${el.fontSizePx.toFixed(0)}px при ширине окна ${doc.viewportWidthPx}px`,
		why: 'Заголовок должен вести, а не занимать экран целиком — размер перестаёт означать важность.',
		selector: el.selector,
		evidence: `${(100 * el.fontSizePx / doc.viewportWidthPx).toFixed(1)}% ширины окна`,
	}));

const ruleSingleFont: Rule = doc => {
	const families = new Set(
		doc.elements
			.filter(el => el.text.length > 0 && el.fontFamily)
			.map(el => primaryFamily(el.fontFamily))
	);
	if (families.size !== 1) { return []; }
	const only = [...families][0];
	return [{
		rule: RULE.singleFont,
		severity: 'info',
		message: `Вся страница набрана одной гарнитурой (${only})`,
		why: 'Одна гарнитура на всё — безопасный выбор по умолчанию; контраст заголовков и текста делать нечем.',
		selector: 'body',
		evidence: only,
	}];
};

/**
 * The kicker: a small tracked upper-case label parked above a much bigger heading.
 *
 * The most recognisable tell there is — it borrows editorial authority the page has not earned.
 * Detected structurally (small + tracked + caps + a size jump right below) rather than by class
 * name, because the name differs in every template while the shape does not.
 */
const ruleKickerLabel: Rule = doc => doc.elements
	.filter(el => el.text.length > 0 && el.text.length <= 40 && el.fontSizePx > 0 && el.fontSizePx <= KICKER_MAX_FONT_PX)
	.filter(el => el.textTransform === 'uppercase' || ratioTracking(el) >= KICKER_MIN_TRACKING_RATIO)
	.filter(el => !/^h1$/.test(el.tag) && !el.interactive)
	.map(el => ({ el, below: stackedBelow(doc, el).find(other => other.fontSizePx >= el.fontSizePx * KICKER_MIN_SIZE_JUMP && other.text.length > 0) }))
	.filter((pair): pair is { el: ElementSnapshot; below: ElementSnapshot } => !!pair.below)
	.map(({ el, below }) => ({
		rule: RULE.kickerLabel,
		severity: 'info' as const,
		message: `Чип-надпись «${el.text.slice(0, 30)}» над заголовком`,
		why: 'Разряженная надпись над заголовком занимает место сути и стоит в каждом сгенерированном лендинге.',
		selector: el.selector,
		evidence: `${el.fontSizePx.toFixed(0)}px над ${below.fontSizePx.toFixed(0)}px`,
	}));

/** A small rounded square holding one glyph, stacked above a heading — the AI feature-card template. */
const ruleIconTileAboveHeading: Rule = doc => doc.elements
	.filter(el => el.text.length === 0 && el.borderRadiusPx >= ICON_TILE_MIN_RADIUS_PX)
	.filter(el => el.widthPx <= ICON_TILE_MAX_PX && el.heightPx <= ICON_TILE_MAX_PX)
	.filter(el => Math.abs(el.widthPx - el.heightPx) <= el.widthPx * 0.25 && el.svgShapeCount > 0)
	.map(el => ({ el, below: stackedBelow(doc, el).find(other => /^h[1-4]$/.test(other.tag)) }))
	.filter((pair): pair is { el: ElementSnapshot; below: ElementSnapshot } => !!pair.below)
	.map(({ el, below }) => ({
		rule: RULE.iconTileAboveHeading,
		severity: 'info' as const,
		message: 'Плитка с иконкой над заголовком карточки',
		why: 'Скруглённый квадрат с иконкой над заголовком — универсальный шаблон карточки-фичи; он ничего не добавляет к смыслу.',
		selector: el.selector,
		evidence: `${el.widthPx.toFixed(0)}×${el.heightPx.toFixed(0)}px, радиус ${el.borderRadiusPx.toFixed(0)}px над ${below.tag}`,
	}));

/** Oversized italic serif as the hero headline: taste in isolation, cliché at scale. */
const ruleItalicSerifHero: Rule = doc => doc.elements
	.filter(el => /^h[1-2]$/.test(el.tag) && el.fontSizePx >= DISPLAY_FONT_PX)
	.filter(el => el.fontStyle === 'italic' && looksSerif(el.fontFamily))
	.map(el => ({
		rule: RULE.italicSerifHero,
		severity: 'info' as const,
		message: 'Крупный курсивный serif в заголовке героя',
		why: 'Курсивная антиква размером во весь экран стала подписью сгенерированных лендингов.',
		selector: el.selector,
		evidence: `${el.fontFamily.split(',')[0]} italic ${el.fontSizePx.toFixed(0)}px`,
	}));

/** A whole sentence set at display size: the headline is a paragraph in a headline's clothes. */
const ruleOversizedHeadlineCopy: Rule = doc => doc.elements
	.filter(el => /^h[1-2]$/.test(el.tag) && el.fontSizePx >= DISPLAY_FONT_PX)
	.map(el => ({ el, words: el.text.split(/\s+/).filter(Boolean).length }))
	.filter(({ words }) => words > MAX_DISPLAY_WORDS)
	.map(({ el, words }) => ({
		rule: RULE.oversizedHeadlineCopy,
		severity: 'info' as const,
		message: `Заголовок из ${words} слов кеглем ${el.fontSizePx.toFixed(0)}px`,
		why: 'Целое предложение display-размером не читается как заголовок — оно занимает первый экран и не ведёт.',
		selector: el.selector,
		evidence: `${words} слов, ${el.fontSizePx.toFixed(0)}px`,
	}));

/** The families that come with the starter rather than with a decision. */
const ruleOverusedFont: Rule = doc => {
	const used = new Map<string, string>();
	for (const el of doc.elements) {
		if (!el.text.length) { continue; }
		const family = primaryFamily(el.fontFamily);
		if (OVERUSED_FAMILIES.includes(family) && !used.has(family)) {
			used.set(family, el.selector);
		}
	}
	return [...used.entries()].map(([family, selector]) => ({
		rule: RULE.overusedFont,
		severity: 'info' as const,
		message: `Гарнитура «${family}» — выбор по умолчанию`,
		why: 'Эти гарнитуры стоят в каждом втором шаблоне: они безупречны и потому ничего не говорят о продукте.',
		selector,
		evidence: family,
	}));
};

const ruleJustifiedText: Rule = doc => doc.elements
	.filter(el => el.textAlign === 'justify' && el.text.length >= 40)
	.map(el => ({
		rule: RULE.justifiedText,
		severity: 'warning' as const,
		message: 'Выключка по ширине',
		why: 'Без переносов браузер растягивает пробелы и пробивает в абзаце «реки».',
		selector: el.selector,
		evidence: 'text-align: justify',
	}));

/**
 * A one- or two-letter word stranded at the end of a line.
 *
 * Russian typography ties prepositions and conjunctions to the word they govern with a
 * non-breaking space; leaving "в", "и", "по" at a line end is the single most common sign that
 * nobody set the text. Measured from real line boxes, never guessed from the source.
 */
const ruleHangingPreposition: Rule = doc => doc.elements
	.filter(el => el.textLineCount >= 2 && el.linesEndingWithShortWord > 0)
	.map(el => ({
		rule: RULE.hangingPreposition,
		severity: 'warning' as const,
		message: `Висячий предлог в конце строки (${el.linesEndingWithShortWord} из ${el.textLineCount})`,
		why: 'Короткое слово, оторванное от своего, читается как обрыв: предлоги и союзы привязывают неразрывным пробелом.',
		selector: el.selector,
		evidence: `строк ${el.textLineCount}, из них с висячим словом ${el.linesEndingWithShortWord}`,
	}));

/** A single word left alone on the last line — the tell the polish pass fixes by hand. */
const ruleOrphanWord: Rule = doc => doc.elements
	.filter(el => el.textLineCount >= 2 && el.lastLineWordCount === 1)
	.map(el => ({
		rule: RULE.orphanWord,
		severity: /^h[1-3]$/.test(el.tag) ? 'warning' as const : 'info' as const,
		message: `Одно слово на последней строке ${/^h[1-3]$/.test(el.tag) ? 'заголовка' : 'абзаца'}`,
		why: 'Одинокое слово под текстом выглядит как случайность вёрстки; его переносят вместе с предыдущим.',
		selector: el.selector,
		evidence: `${el.textLineCount} строк, на последней 1 слово`,
	}));

export const TYPOGRAPHY_RULES: readonly Rule[] = [
	ruleTinyText,
	ruleUndersizedUiText,
	ruleTightLeading,
	ruleAllCapsBody,
	ruleTracking,
	ruleFlatHierarchy,
	ruleSkippedHeading,
	ruleOversizedH1,
	ruleSingleFont,
	ruleKickerLabel,
	ruleIconTileAboveHeading,
	ruleItalicSerifHero,
	ruleOversizedHeadlineCopy,
	ruleOverusedFont,
	ruleJustifiedText,
	ruleHangingPreposition,
	ruleOrphanWord,
];
