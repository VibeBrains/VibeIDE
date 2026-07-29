/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Detectors for machine-generated design tells ("ai-slop") — pure decision layer.
 *
 * Why deterministic rules instead of asking a model "is this pretty": a model answers
 * differently on the same page twice, cannot point at the element, and costs a request. These
 * rules read a normalised snapshot of what the page ACTUALLY computed (font sizes, colours,
 * spacing), so a finding is reproducible and always carries the element it came from.
 *
 * Provenance: the catalogue of tells is informed by the public `pbakaus/impeccable` project
 * (Apache-2.0). No code was copied — that licence does not fit this MIT tree; the checks here
 * are written from the descriptions of the antipatterns, which are facts about design, not code.
 *
 * The snapshot is produced elsewhere (preview page → chrome → service), so this module stays
 * testable without a browser.
 */

/** One element as the page computed it. Only what a rule actually needs. */
export type ElementSnapshot = {
	/** Stable pointer back to the element for the UI, e.g. `main > section:nth-child(2) > h1`. */
	selector: string;
	tag: string;
	/** Visible text, trimmed and collapsed; empty for layout-only nodes. */
	text: string;
	classes: string[];
	/** Depth of nesting inside card-like containers, computed by the collector. */
	cardDepth: number;
	/** Computed values, already parsed into numbers where the CSS unit is px. */
	fontSizePx: number;
	lineHeightPx: number;
	letterSpacingPx: number;
	fontFamily: string;
	fontWeight: number;
	textTransform: string;
	textAlign: string;
	/** sRGB 0-255. */
	color: [number, number, number];
	/** Effective background behind the element (collector walks up through transparent parents). */
	backgroundColor: [number, number, number];
	backgroundImage: string;
	backgroundClip: string;
	boxShadow: string;
	animationName: string;
	/** Layout box in CSS px. */
	widthPx: number;
	heightPx: number;
	paddingPx: { top: number; right: number; bottom: number; left: number };
	/** True when the element responds to clicks (button, a, [role=button], onclick). */
	interactive: boolean;
};

export type DocumentSnapshot = {
	url: string;
	viewportWidthPx: number;
	elements: ElementSnapshot[];
	/** Headings in document order, for hierarchy checks. */
	headings: { tag: string; text: string; fontSizePx: number }[];
};

export type Severity = 'error' | 'warning' | 'info';

export type Finding = {
	rule: string;
	severity: Severity;
	/** What is wrong, in the user's language. */
	message: string;
	/** Why it reads as machine-made or hurts the reader — one sentence, no lecturing. */
	why: string;
	selector: string;
	/** The measured value that triggered the rule, so the user can argue with the number. */
	evidence: string;
};

// ---------------------------------------------------------------------------------------------
// thresholds — named, because every one of them is a judgement call someone will want to change
// ---------------------------------------------------------------------------------------------

/** Below this, body copy stops being comfortable on a laptop screen. */
const MIN_BODY_FONT_PX = 12;
/** Interactive labels need more than body copy: the user aims at them. */
const MIN_INTERACTIVE_FONT_PX = 13;
/** WCAG AA for normal text. */
const MIN_CONTRAST_NORMAL = 4.5;
/** WCAG AA for large text (≥ 24px, or ≥ 18.66px bold). */
const MIN_CONTRAST_LARGE = 3;
const LARGE_TEXT_PX = 24;
const LARGE_TEXT_BOLD_PX = 18.66;
/** Tighter than this and descenders start colliding on multi-line copy. */
const MIN_BODY_LINE_HEIGHT_RATIO = 1.25;
/** Beyond this the eye loses the line start on the way back. */
const MAX_LINE_LENGTH_CH = 95;
/** Text this long in all-caps stops being readable. */
const MAX_ALL_CAPS_CHARS = 40;
/** Apple/Google agree on ~44px as the smallest comfortable touch target. */
const MIN_TOUCH_TARGET_PX = 44;
/** Cards inside cards inside cards — the third level is where it becomes noise. */
const MAX_CARD_DEPTH = 2;
/** Letter-spacing outside this band is a "designed" look applied without reason. */
const MAX_TRACKING_RATIO = 0.2;
const MIN_TRACKING_RATIO = -0.06;
/** An h1 larger than this share of the viewport shouts rather than leads. */
const MAX_H1_VIEWPORT_RATIO = 0.13;
/** Headline levels closer than this in size do not read as a hierarchy. */
const MIN_HEADING_STEP_RATIO = 1.08;

/** Words that promise instead of saying. Matched whole-word, case-insensitive. */
const MARKETING_FILLER = [
	'revolutionary', 'seamless', 'unleash', 'game-changing', 'cutting-edge', 'next-level',
	'elevate', 'supercharge', 'effortlessly', 'unlock the power', 'take it to the next level',
	'революционн', 'инновационн', 'непревзойдённ', 'уникальн в своём роде', 'на новый уровень',
];

/** The violet/indigo ramp every image generator and starter template reaches for first. */
// Индиго-фиолетовая полоса. Нижняя граница именно 245, а не 255: канонический #7C5CFF —
// цвет по умолчанию половины генераторов — имеет hue 252 и при узкой границе не ловился.
const AI_VIOLET_HUE_RANGE: [number, number] = [245, 290];
const AI_VIOLET_MIN_SATURATION = 0.45;

// ---------------------------------------------------------------------------------------------
// colour helpers
// ---------------------------------------------------------------------------------------------

const srgbToLinear = (channel: number): number => {
	const c = channel / 255;
	return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

export function relativeLuminance([r, g, b]: [number, number, number]): number {
	return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

/** Hue in degrees plus saturation 0..1 — enough to spot a colour family without a full HSL type. */
export function hueSaturation([r, g, b]: [number, number, number]): { hue: number; saturation: number } {
	const rn = r / 255, gn = g / 255, bn = b / 255;
	const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
	const delta = max - min;
	let hue = 0;
	if (delta !== 0) {
		if (max === rn) { hue = 60 * (((gn - bn) / delta) % 6); }
		else if (max === gn) { hue = 60 * ((bn - rn) / delta + 2); }
		else { hue = 60 * ((rn - gn) / delta + 4); }
	}
	if (hue < 0) { hue += 360; }
	const lightness = (max + min) / 2;
	const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
	return { hue, saturation };
}

// ---------------------------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------------------------

const isBodyText = (el: ElementSnapshot): boolean =>
	el.text.length >= 40 && !/^h[1-6]$/.test(el.tag) && !el.interactive;

const requiredContrastFor = (el: ElementSnapshot): number =>
	el.fontSizePx >= LARGE_TEXT_PX || (el.fontWeight >= 700 && el.fontSizePx >= LARGE_TEXT_BOLD_PX)
		? MIN_CONTRAST_LARGE
		: MIN_CONTRAST_NORMAL;

type Rule = (doc: DocumentSnapshot) => Finding[];

const ruleTinyText: Rule = doc => doc.elements
	.filter(el => el.text.length > 0 && el.fontSizePx > 0 && el.fontSizePx < MIN_BODY_FONT_PX && !el.interactive)
	.map(el => ({
		rule: 'tiny-text',
		severity: 'warning' as const,
		message: `Текст ${el.fontSizePx.toFixed(0)}px — мельче читаемого минимума`,
		why: 'Ниже 12px текст перестают читать и начинают угадывать.',
		selector: el.selector,
		evidence: `font-size: ${el.fontSizePx}px`,
	}));

const ruleUndersizedUiText: Rule = doc => doc.elements
	.filter(el => el.interactive && el.text.length > 0 && el.fontSizePx > 0 && el.fontSizePx < MIN_INTERACTIVE_FONT_PX)
	.map(el => ({
		rule: 'undersized-ui-text',
		severity: 'warning' as const,
		message: `Подпись интерактивного элемента ${el.fontSizePx.toFixed(0)}px`,
		why: 'В кнопку целятся — её подпись должна читаться быстрее, чем основной текст, а не медленнее.',
		selector: el.selector,
		evidence: `font-size: ${el.fontSizePx}px`,
	}));

const ruleLowContrast: Rule = doc => doc.elements
	.filter(el => el.text.length > 0)
	.map(el => ({ el, ratio: contrastRatio(el.color, el.backgroundColor), required: requiredContrastFor(el) }))
	.filter(({ ratio, required }) => ratio < required)
	.map(({ el, ratio, required }) => ({
		rule: 'low-contrast',
		severity: 'error' as const,
		message: `Контраст ${ratio.toFixed(2)}:1 при норме ${required}:1`,
		why: 'Текст ниже порога WCAG AA пропадает на ярком экране и у слабовидящих.',
		selector: el.selector,
		evidence: `цвет ${el.color.join(',')} на фоне ${el.backgroundColor.join(',')}`,
	}));

const ruleGradientText: Rule = doc => doc.elements
	.filter(el => el.backgroundClip === 'text' && /gradient/.test(el.backgroundImage))
	.map(el => ({
		rule: 'gradient-text',
		severity: 'info' as const,
		message: 'Заголовок залит градиентом',
		why: 'Градиентный текст — первый приём любого генератора; он же роняет контраст на светлом конце.',
		selector: el.selector,
		evidence: `background-clip: text; ${el.backgroundImage.slice(0, 60)}`,
	}));

const ruleAiViolet: Rule = doc => doc.elements
	.filter(el => el.text.length > 0 && (/^h[1-3]$/.test(el.tag) || el.fontSizePx >= 20))
	.filter(el => {
		const { hue, saturation } = hueSaturation(el.color);
		return saturation >= AI_VIOLET_MIN_SATURATION && hue >= AI_VIOLET_HUE_RANGE[0] && hue <= AI_VIOLET_HUE_RANGE[1];
	})
	.map(el => ({
		rule: 'ai-color-palette',
		severity: 'info' as const,
		message: 'Фиолетово-индиговый заголовок — палитра по умолчанию',
		why: 'Этот оттенок ставят генераторы и стартеры; он ничего не говорит о продукте.',
		selector: el.selector,
		evidence: `color rgb(${el.color.join(',')})`,
	}));

const ruleTightLeading: Rule = doc => doc.elements
	.filter(isBodyText)
	.filter(el => el.fontSizePx > 0 && el.lineHeightPx > 0 && el.lineHeightPx / el.fontSizePx < MIN_BODY_LINE_HEIGHT_RATIO)
	.map(el => ({
		rule: 'tight-leading',
		severity: 'warning' as const,
		message: `Межстрочный интервал ${(el.lineHeightPx / el.fontSizePx).toFixed(2)} — строки слипаются`,
		why: 'На абзаце в несколько строк глаз теряет, куда возвращаться.',
		selector: el.selector,
		evidence: `line-height: ${el.lineHeightPx}px при font-size: ${el.fontSizePx}px`,
	}));

const ruleLineLength: Rule = doc => doc.elements
	.filter(isBodyText)
	.filter(el => {
		// ~0.5em per character is the usual average for proportional fonts.
		const approxCh = el.fontSizePx > 0 ? el.widthPx / (el.fontSizePx * 0.5) : 0;
		return approxCh > MAX_LINE_LENGTH_CH;
	})
	.map(el => ({
		rule: 'line-length',
		severity: 'warning' as const,
		message: 'Строка текста длиннее 95 знаков',
		why: 'На длинной строке читатель промахивается мимо начала следующей.',
		selector: el.selector,
		evidence: `ширина ${el.widthPx.toFixed(0)}px при font-size ${el.fontSizePx}px`,
	}));

const ruleJustifiedText: Rule = doc => doc.elements
	.filter(el => el.textAlign === 'justify' && el.text.length >= 40)
	.map(el => ({
		rule: 'justified-text',
		severity: 'warning' as const,
		message: 'Выключка по ширине',
		why: 'Без переносов браузер растягивает пробелы и пробивает в абзаце «реки».',
		selector: el.selector,
		evidence: 'text-align: justify',
	}));

const ruleAllCapsBody: Rule = doc => doc.elements
	.filter(el => el.textTransform === 'uppercase' && el.text.length > MAX_ALL_CAPS_CHARS)
	.map(el => ({
		rule: 'all-caps-body',
		severity: 'warning' as const,
		message: `Капслок на ${el.text.length} знаках`,
		why: 'Прописные лишают слова силуэта — длинный текст в них читается по буквам.',
		selector: el.selector,
		evidence: `text-transform: uppercase, длина ${el.text.length}`,
	}));

const ruleTracking: Rule = doc => doc.elements
	.filter(el => el.text.length > 0 && el.fontSizePx > 0)
	.map(el => ({ el, ratio: el.letterSpacingPx / el.fontSizePx }))
	.filter(({ ratio, el }) => (ratio > MAX_TRACKING_RATIO || ratio < MIN_TRACKING_RATIO) && el.text.length >= 12)
	.map(({ el, ratio }) => ({
		rule: ratio > 0 ? 'wide-tracking' : 'extreme-negative-tracking',
		severity: 'info' as const,
		message: ratio > 0
			? `Разрядка ${(ratio * 100).toFixed(0)}% от кегля`
			: `Отрицательный трекинг ${(ratio * 100).toFixed(0)}% — буквы наезжают`,
		why: 'Трекинг настраивают под конкретный кегль и гарнитуру; ровное значение «для красоты» видно сразу.',
		selector: el.selector,
		evidence: `letter-spacing: ${el.letterSpacingPx}px при ${el.fontSizePx}px`,
	}));

const ruleTouchTarget: Rule = doc => doc.elements
	.filter(el => el.interactive && el.widthPx > 0 && el.heightPx > 0)
	.filter(el => el.heightPx < MIN_TOUCH_TARGET_PX && el.widthPx < MIN_TOUCH_TARGET_PX)
	.map(el => ({
		rule: 'cramped-target',
		severity: 'warning' as const,
		message: `Кликабельная область ${el.widthPx.toFixed(0)}×${el.heightPx.toFixed(0)}px`,
		why: 'Меньше 44px пальцем промахиваются — на телефоне это заметно сразу.',
		selector: el.selector,
		evidence: `${el.widthPx.toFixed(0)}×${el.heightPx.toFixed(0)}px`,
	}));

const ruleNestedCards: Rule = doc => doc.elements
	.filter(el => el.cardDepth > MAX_CARD_DEPTH)
	.map(el => ({
		rule: 'nested-cards',
		severity: 'info' as const,
		message: `Карточка вложена на ${el.cardDepth}-й уровень`,
		why: 'Рамка в рамке в рамке не добавляет структуры — она добавляет шум.',
		selector: el.selector,
		evidence: `глубина карточек: ${el.cardDepth}`,
	}));

const ruleDarkGlow: Rule = doc => doc.elements
	.filter(el => {
		if (!el.boxShadow || el.boxShadow === 'none') { return false; }
		// A coloured, spread-out, offset-less shadow is a glow, not a shadow.
		const isColourful = /rgba?\([^)]*\)/.test(el.boxShadow) && !/rgba?\(0,\s*0,\s*0/.test(el.boxShadow);
		const hasNoOffset = /(^|\s)0px 0px/.test(el.boxShadow);
		return isColourful && hasNoOffset;
	})
	.map(el => ({
		rule: 'dark-glow',
		severity: 'info' as const,
		message: 'Цветное свечение вместо тени',
		why: 'Свечение имитирует подсветку, которой в макете нет; свет должен падать откуда-то.',
		selector: el.selector,
		evidence: el.boxShadow.slice(0, 70),
	}));

const ruleRadialHalo: Rule = doc => doc.elements
	.filter(el => /radial-gradient/.test(el.backgroundImage) && el.widthPx > 300 && el.heightPx > 200)
	.map(el => ({
		rule: 'radial-halo',
		severity: 'info' as const,
		message: 'Радиальный ореол на фоне крупного блока',
		why: 'Размытое пятно за героем — дежурный приём генераторов, смысла в композиции оно не несёт.',
		selector: el.selector,
		evidence: el.backgroundImage.slice(0, 70),
	}));

const ruleDecorativeAnimation: Rule = doc => doc.elements
	.filter(el => /pulse|blink|marquee|bounce|float|shimmer/i.test(el.animationName))
	.map(el => ({
		rule: 'decorative-animation',
		severity: 'info' as const,
		message: `Декоративная анимация «${el.animationName}»`,
		why: 'Постоянное движение перетягивает внимание с содержимого и не выключается по желанию читателя.',
		selector: el.selector,
		evidence: `animation-name: ${el.animationName}`,
	}));

const ruleFlatHierarchy: Rule = doc => {
	const levels = new Map<string, number>();
	for (const h of doc.headings) {
		const current = levels.get(h.tag);
		if (current === undefined || h.fontSizePx > current) { levels.set(h.tag, h.fontSizePx); }
	}
	const findings: Finding[] = [];
	const ordered = ['h1', 'h2', 'h3', 'h4'].filter(tag => levels.has(tag));
	for (let i = 0; i + 1 < ordered.length; i++) {
		const bigger = levels.get(ordered[i])!;
		const smaller = levels.get(ordered[i + 1])!;
		if (smaller > 0 && bigger / smaller < MIN_HEADING_STEP_RATIO) {
			findings.push({
				rule: 'flat-type-hierarchy',
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
	const findings: Finding[] = [];
	let previous = 0;
	for (const h of doc.headings) {
		const level = Number(h.tag.slice(1));
		if (previous > 0 && level > previous + 1) {
			findings.push({
				rule: 'skipped-heading',
				severity: 'warning',
				message: `${h.tag} идёт сразу после h${previous}`,
				why: 'Пропуск уровня ломает оглавление для скринридера — он читает структуру, а не размеры.',
				selector: h.tag,
				evidence: `h${previous} → ${h.tag}: «${h.text.slice(0, 40)}»`,
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
		rule: 'oversized-h1',
		severity: 'info' as const,
		message: `Заголовок ${el.fontSizePx.toFixed(0)}px при ширине окна ${doc.viewportWidthPx}px`,
		why: 'Заголовок должен вести, а не занимать экран целиком — размер перестаёт означать важность.',
		selector: el.selector,
		evidence: `${(100 * el.fontSizePx / doc.viewportWidthPx).toFixed(1)}% ширины окна`,
	}));

const ruleMarketingFiller: Rule = doc => {
	const findings: Finding[] = [];
	for (const el of doc.elements) {
		if (el.text.length < 8) { continue; }
		const lower = el.text.toLowerCase();
		const hit = MARKETING_FILLER.find(word => lower.includes(word));
		if (hit) {
			findings.push({
				rule: 'marketing-filler',
				severity: 'info',
				message: `Пустое обещание в тексте: «${hit}»`,
				why: 'Такие слова описывают восторг автора, а не то, что продукт делает.',
				selector: el.selector,
				evidence: el.text.slice(0, 80),
			});
		}
	}
	return findings;
};

const ruleEmDashOveruse: Rule = doc => doc.elements
	.filter(el => el.text.length >= 120)
	.map(el => ({ el, count: (el.text.match(/—/g) ?? []).length }))
	// Two or more per 120 characters reads as generated prose rather than written.
	.filter(({ el, count }) => count >= 2 && count / (el.text.length / 120) >= 2)
	.map(({ el, count }) => ({
		rule: 'em-dash-overuse',
		severity: 'info' as const,
		message: `Тире ${count} раз в одном абзаце`,
		why: 'Плотность длинных тире — самый заметный след текста, написанного моделью.',
		selector: el.selector,
		evidence: el.text.slice(0, 80),
	}));

const ruleSingleFont: Rule = doc => {
	const families = new Set(
		doc.elements
			.filter(el => el.text.length > 0 && el.fontFamily)
			// Only the first family matters: the rest of the stack is a fallback chain.
			.map(el => el.fontFamily.split(',')[0].trim().replace(/["']/g, '').toLowerCase())
	);
	if (families.size !== 1) { return []; }
	const only = [...families][0];
	return [{
		rule: 'single-font',
		severity: 'info',
		message: `Вся страница набрана одной гарнитурой (${only})`,
		why: 'Одна гарнитура на всё — безопасный выбор по умолчанию; контраст заголовков и текста делать нечем.',
		selector: 'body',
		evidence: only,
	}];
};

/** Every rule in the catalogue. Adding one here is the only registration needed. */
const RULES: Rule[] = [
	ruleTinyText,
	ruleUndersizedUiText,
	ruleLowContrast,
	ruleGradientText,
	ruleAiViolet,
	ruleTightLeading,
	ruleLineLength,
	ruleJustifiedText,
	ruleAllCapsBody,
	ruleTracking,
	ruleTouchTarget,
	ruleNestedCards,
	ruleDarkGlow,
	ruleRadialHalo,
	ruleDecorativeAnimation,
	ruleFlatHierarchy,
	ruleSkippedHeading,
	ruleOversizedH1,
	ruleMarketingFiller,
	ruleEmDashOveruse,
	ruleSingleFont,
];

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Runs the catalogue over a page snapshot.
 *
 * Ordering is deterministic (severity, then rule, then selector) so two runs on the same page
 * produce byte-identical output — a report that reshuffles itself cannot be diffed.
 */
export function reviewDesign(doc: DocumentSnapshot): Finding[] {
	const findings = RULES.flatMap(rule => rule(doc));
	return findings.sort((a, b) =>
		SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
		|| a.rule.localeCompare(b.rule)
		|| a.selector.localeCompare(b.selector));
}

/** Counts per severity — the one-line verdict the UI shows before the list. */
export function summarize(findings: Finding[]): { error: number; warning: number; info: number; total: number } {
	return {
		error: findings.filter(f => f.severity === 'error').length,
		warning: findings.filter(f => f.severity === 'warning').length,
		info: findings.filter(f => f.severity === 'info').length,
		total: findings.length,
	};
}
