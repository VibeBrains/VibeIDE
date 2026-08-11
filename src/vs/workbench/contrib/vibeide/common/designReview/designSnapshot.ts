/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a measured page looks like to the rules, plus the colour maths every category needs.
 *
 * The page collects, the rules judge: this module is the contract between the two and holds no
 * opinion of its own. Everything here is a value the browser ACTUALLY computed, so a finding can
 * always be argued with by re-measuring rather than by taste.
 */

/** Which viewport a snapshot was taken in — a finding is only true for the width it was measured at. */
export type ViewportLabel = 'desktop' | 'mobile';

/** One element as the page computed it. Only what a rule actually needs. */
export type ElementSnapshot = {
	/** Stable pointer back to the element for the UI, e.g. `main > section:nth-child(2) > h1`. */
	selector: string;
	/** Selector of the parent, so rules can group siblings without walking a tree. */
	parentSelector: string;
	tag: string;
	/** Visible text, trimmed and collapsed; empty for layout-only nodes. */
	text: string;
	classes: string[];
	/** Tag names of the first few children — enough to spot repeated card templates. */
	childTags: string[];
	/** Depth of nesting inside card-like containers, computed by the collector. */
	cardDepth: number;
	/** Computed values, already parsed into numbers where the CSS unit is px. */
	fontSizePx: number;
	lineHeightPx: number;
	letterSpacingPx: number;
	fontFamily: string;
	fontWeight: number;
	fontStyle: string;
	textTransform: string;
	textAlign: string;
	/** sRGB 0-255. */
	color: [number, number, number];
	/** Effective background behind the element (collector walks up through transparent parents). */
	backgroundColor: [number, number, number];
	/** Alpha of the element's OWN background — an opaque layer can occlude what is under it. */
	ownBackgroundAlpha: number;
	backgroundImage: string;
	backgroundClip: string;
	boxShadow: string;
	/** `blur(…)` here is the glassmorphism tell; empty or `none` otherwise. */
	backdropFilter: string;
	borderRadiusPx: number;
	/** Per-side widths: a single thick side is the "side-tab accent" tell. */
	borderWidthPx: { top: number; right: number; bottom: number; left: number };
	borderColor: [number, number, number];
	/** Alpha of the border colour, so a fully transparent border is not read as a border. */
	borderAlpha: number;
	animationName: string;
	animationTimingFunction: string;
	animationDurationMs: number;
	transitionProperty: string;
	transitionTimingFunction: string;
	position: string;
	zIndex: number;
	overflowX: string;
	overflowY: string;
	/** Layout box in CSS px, relative to the document (not the viewport). */
	widthPx: number;
	heightPx: number;
	leftPx: number;
	topPx: number;
	/** Content extent, for "content is wider than its box" without a second measurement pass. */
	scrollWidthPx: number;
	clientWidthPx: number;
	paddingPx: { top: number; right: number; bottom: number; left: number };
	marginPx: { top: number; right: number; bottom: number; left: number };
	/** For `img`: the resolved source and whether the bitmap actually arrived. */
	imgSrc: string;
	imgNaturalWidthPx: number;
	/** Number of shape primitives in an inline SVG child — placeholder art is assembled from them. */
	svgShapeCount: number;
	/**
	 * How the text actually broke into lines, measured with a Range (0 when not measured).
	 *
	 * Line breaking cannot be derived from the source: it depends on the font, the box and the
	 * hyphenation the browser chose. Only the page knows, so the page counts — and only for a
	 * budgeted sample of multi-line text, because each word costs a rect.
	 */
	textLineCount: number;
	/** Lines (except the last) ending in a one- or two-letter word — a hanging preposition. */
	linesEndingWithShortWord: number;
	/** Words on the last line: one is an orphan hanging under the paragraph. */
	lastLineWordCount: number;
	/** True when the element responds to clicks (button, a, [role=button], onclick). */
	interactive: boolean;

	// --- Состояния интерактивного элемента -------------------------------------------------
	//
	// Их нельзя вывести из статического снимка: фокус, наведение и запрет живут в CSS-правилах,
	// а не в вычисленном стиле покоя. Собираются чтением таблиц стилей документа — фокусировать
	// элемент по-настоящему нельзя, это сдвинуло бы скролл и изменило измеряемую страницу.

	/** `outline-style` в покое: `none` у элемента без замены — обычная причина невидимого фокуса. */
	outlineStyle: string;
	outlineWidthPx: number;
	/** Есть ли в CSS правило `:focus` или `:focus-visible`, применимое к элементу. */
	hasFocusRule: boolean;
	/** Есть ли правило `:hover`. */
	hasHoverRule: boolean;
	/** Элемент действительно выключен: атрибут `disabled` или `aria-disabled="true"`. */
	disabled: boolean;
	/**
	 * Не удалось прочитать часть таблиц стилей (cross-origin). Тогда «правила нет» означает
	 * «не смогли посмотреть», и правила состояний обязаны промолчать, а не обвинить.
	 */
	styleRulesUnreadable: boolean;

	// --- Разметка: то, что читает не глаз, а программа чтения с экрана ----------------------
	//
	// Второй слой по-компонентных чек-листов. На скриншоте эти дефекты не видны вовсе: кнопка
	// с иконкой выглядит прекрасно и молчит, поле с плейсхолдером вместо подписи выглядит
	// аккуратно ровно до первого символа ввода.

	/**
	 * Доступное имя — то, что произнесёт программа чтения с экрана. Считается страницей по
	 * обычному порядку: `aria-label`, `aria-labelledby`, связанный `<label>`, содержимое,
	 * `alt`, `title`. Пусто — элемент безымянный.
	 */
	accessibleName: string;
	/** `input`, `select`, `textarea` — поля, которым подпись обязательна. */
	isFormField: boolean;
	/** `type` поля: `hidden` и кнопочные типы подписи через label не требуют. */
	inputType: string;
	/** Есть ли у поля плейсхолдер — он часто стоит ВМЕСТО подписи, хотя ею не является. */
	hasPlaceholder: boolean;
	/**
	 * У `img` атрибут `alt` присутствует. Отличается от пустого значения намеренно:
	 * `alt=""` — законное «изображение декоративное, читать нечего», а отсутствие атрибута —
	 * пропуск, при котором программа чтения зачитает имя файла.
	 */
	hasAltAttribute: boolean;
};

export type DocumentSnapshot = {
	url: string;
	viewportWidthPx: number;
	viewportHeightPx: number;
	/** Set when the page was measured at a named width; absent in older snapshots. */
	viewport?: ViewportLabel;
	/** Document scroll extent — horizontal overflow of the page as a whole. */
	documentScrollWidthPx?: number;
	elements: ElementSnapshot[];
	/** Headings in document order, for hierarchy checks. */
	headings: { tag: string; text: string; fontSizePx: number }[];
};

export type Severity = 'error' | 'warning' | 'info';

/**
 * Whether a project may declare the finding to be its identity.
 *
 * `floor` is the quality bar nothing overrides — unreadable contrast, a target too small to hit,
 * a heading level skipped, an image that never arrived. `drift` is a stylistic tell: true by
 * default, but a project that pinned the look on purpose (a pixel-art world keeps its zero-blur
 * stepped shadows) can accept it in its design system and the finding stops being a defect.
 */
export type RuleClass = 'floor' | 'drift';

export type Finding = {
	rule: string;
	severity: Severity;
	ruleClass: RuleClass;
	/** What is wrong, in the user's language. */
	message: string;
	/** Why it reads as machine-made or hurts the reader — one sentence, no lecturing. */
	why: string;
	selector: string;
	/** The measured value that triggered the rule, so the user can argue with the number. */
	evidence: string;
	/** Viewport the finding was measured in; absent when the snapshot did not say. */
	viewport?: ViewportLabel;
	/** Set when the project's design system accepted this drift — carries the stated reason. */
	accepted?: { reason: string };
};

/**
 * What a rule returns. The class is NOT part of it: whether a finding is a quality floor or a
 * style drift is a property of the rule id, declared once in the catalogue (`ruleIds.ts`), and the
 * facade stamps it on. A rule that could name its own class could disagree with the catalogue the
 * project reads when it accepts drift.
 */
export type RuleFinding = Omit<Finding, 'ruleClass'>;

export type Rule = (doc: DocumentSnapshot) => RuleFinding[];

// ---------------------------------------------------------------------------------------------
// colour maths
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

/** Lightness 0..1 — the third axis, needed to tell "beige" from "brown". */
export function lightness([r, g, b]: [number, number, number]): number {
	const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
	return (max + min) / 2;
}

// ---------------------------------------------------------------------------------------------
// shared predicates
// ---------------------------------------------------------------------------------------------

/** Body copy: long enough to be read as prose, not a heading, not a control. */
export const isBodyText = (el: ElementSnapshot): boolean =>
	el.text.length >= 40 && !/^h[1-6]$/.test(el.tag) && !el.interactive;

/** First family in the stack; the rest is a fallback chain and says nothing about intent. */
export const primaryFamily = (fontFamily: string): string =>
	fontFamily.split(',')[0].trim().replace(/["']/g, '').toLowerCase();

/** Serif detection from the family name — the only signal a computed style gives us. */
export const looksSerif = (fontFamily: string): boolean =>
	/serif|georgia|garamond|times|playfair|instrument|baskerville|didot|bodoni|cormorant|lora|merriweather/i
		.test(fontFamily) && !/sans-serif/i.test(primaryFamily(fontFamily));

export const rgbToHex = ([r, g, b]: [number, number, number]): string =>
	'#' + [r, g, b].map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
