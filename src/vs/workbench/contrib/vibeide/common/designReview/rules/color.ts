/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Colour rules: readability first, then the palettes that arrive by reflex. */

import { ElementSnapshot, Rule, RuleFinding, contrastRatio, hueSaturation, isBodyText, lightness } from '../designSnapshot.js';
import { RULE } from '../ruleIds.js';

/** WCAG AA for normal text. */
const MIN_CONTRAST_NORMAL = 4.5;
/** WCAG AA for large text (≥ 24px, or ≥ 18.66px bold). */
const MIN_CONTRAST_LARGE = 3;
const LARGE_TEXT_PX = 24;
const LARGE_TEXT_BOLD_PX = 18.66;

/**
 * The violet/indigo ramp every image generator and starter template reaches for first.
 *
 * Индиго-фиолетовая полоса. Нижняя граница именно 245, а не 255: канонический #7C5CFF —
 * цвет по умолчанию половины генераторов — имеет hue 252 и при узкой границе не ловился.
 */
const AI_VIOLET_HUE_RANGE: [number, number] = [245, 290];
const AI_VIOLET_MIN_SATURATION = 0.45;
/** Warm off-white ("AI beige"): light, low saturation, hue in the cream band. */
const BEIGE_HUE_RANGE: [number, number] = [20, 60];
const BEIGE_MIN_LIGHTNESS = 0.86;
const BEIGE_MAX_SATURATION = 0.45;
const BEIGE_MIN_SATURATION = 0.08;
/** A surface this large sets the page's tone rather than decorating a corner of it. */
const PAGE_SURFACE_MIN_WIDTH_PX = 600;
const PAGE_SURFACE_MIN_HEIGHT_PX = 400;
/** A halo is a big soft radial blob; smaller radial gradients are legitimate shading. */
const HALO_MIN_WIDTH_PX = 300;
const HALO_MIN_HEIGHT_PX = 200;

/** Above this many unmeasured texts the page has one textured surface, not many separate problems. */
const MAX_UNMEASURABLE_PER_ELEMENT = 5;

/**
 * Labels of actions that destroy or revoke something. `cancel` alone stays out: it is the dismiss
 * button of every dialog; it becomes destructive with the object it cancels. Cyrillic has no `\b`
 * in JS regexes, so word edges there are spelled out.
 */
const DESTRUCTIVE_LABEL_EN = /\b(delete|remove|revoke|destroy|discard|erase|deactivate|terminate|wipe|unpublish|uninstall|unsubscribe|cancel\s+(subscription|plan|account|membership|order|booking|reservation|payment|transfer)|close\s+account|leave\s+(team|workspace|organi[sz]ation))\b/i;
const DESTRUCTIVE_LABEL_RU = /(^|[^а-яё])(удалить|удалите|удаление|стереть|уничтожить|отозвать|деактивировать|отписаться|отменить\s+(подписку|заказ|бронь|бронирование|платёж|платеж|перевод|оплату)|закрыть\s+(аккаунт|счёт|счет)|покинуть\s+(команду|организацию|пространство))(?![а-яё])/i;
/** Danger family: reds and the red end of orange. */
const DANGER_HUE_MAX = 30;
const DANGER_HUE_MIN = 330;
/** Below this saturation a colour is a neutral, and a neutral destructive button is not wearing a promise. */
const ACCENT_MIN_SATURATION = 0.4;
const ACCENT_LIGHTNESS_RANGE: [number, number] = [0.15, 0.9];
/** Pure black on a near-white surface — the unchosen default. */
const PURE_BLACK_SURFACE_MIN_LIGHTNESS = 0.95;

const requiredContrastFor = (el: ElementSnapshot): number =>
	el.fontSizePx >= LARGE_TEXT_PX || (el.fontWeight >= 700 && el.fontSizePx >= LARGE_TEXT_BOLD_PX)
		? MIN_CONTRAST_LARGE
		: MIN_CONTRAST_NORMAL;

const ruleLowContrast: Rule = doc => doc.elements
	// Over a picture the effective colour is a guess, and a ratio computed from a guess is wrong in
	// both directions — `contrast-unmeasurable` says so instead.
	.filter(el => el.text.length > 0 && !el.backgroundUnmeasurable)
	.map(el => ({ el, ratio: contrastRatio(el.color, el.backgroundColor), required: requiredContrastFor(el) }))
	.filter(({ ratio, required }) => ratio < required)
	.map(({ el, ratio, required }) => ({
		rule: RULE.lowContrast,
		severity: 'error' as const,
		message: `Контраст ${ratio.toFixed(2)}:1 при норме ${required}:1`,
		why: 'Текст ниже порога WCAG AA пропадает на ярком экране и у слабовидящих.',
		selector: el.selector,
		evidence: `цвет ${el.color.join(',')} на фоне ${el.backgroundColor.join(',')}`,
	}));

const ruleGradientText: Rule = doc => doc.elements
	.filter(el => el.backgroundClip === 'text' && /gradient/.test(el.backgroundImage))
	.map(el => ({
		rule: RULE.gradientText,
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
		rule: RULE.aiColorPalette,
		severity: 'info' as const,
		message: 'Фиолетово-индиговый заголовок — палитра по умолчанию',
		why: 'Этот оттенок ставят генераторы и стартеры; он ничего не говорит о продукте.',
		selector: el.selector,
		evidence: `color rgb(${el.color.join(',')})`,
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
		rule: RULE.darkGlow,
		severity: 'info' as const,
		message: 'Цветное свечение вместо тени',
		why: 'Свечение имитирует подсветку, которой в макете нет; свет должен падать откуда-то.',
		selector: el.selector,
		evidence: el.boxShadow.slice(0, 70),
	}));

const ruleRadialHalo: Rule = doc => doc.elements
	.filter(el => /radial-gradient/.test(el.backgroundImage) && el.widthPx > HALO_MIN_WIDTH_PX && el.heightPx > HALO_MIN_HEIGHT_PX)
	.map(el => ({
		rule: RULE.radialHalo,
		severity: 'info' as const,
		message: 'Радиальный ореол на фоне крупного блока',
		why: 'Размытое пятно за героем — дежурный приём генераторов, смысла в композиции оно не несёт.',
		selector: el.selector,
		evidence: el.backgroundImage.slice(0, 70),
	}));

/** The warm off-white that gets picked when nobody chose a background. */
const ruleBeigeSurface: Rule = doc => doc.elements
	.filter(el => el.ownBackgroundAlpha > 0.5)
	.filter(el => el.widthPx >= PAGE_SURFACE_MIN_WIDTH_PX && el.heightPx >= PAGE_SURFACE_MIN_HEIGHT_PX)
	.filter(el => {
		const { hue, saturation } = hueSaturation(el.backgroundColor);
		return lightness(el.backgroundColor) >= BEIGE_MIN_LIGHTNESS
			&& saturation >= BEIGE_MIN_SATURATION && saturation <= BEIGE_MAX_SATURATION
			&& hue >= BEIGE_HUE_RANGE[0] && hue <= BEIGE_HUE_RANGE[1];
	})
	.map(el => ({
		rule: RULE.beigeSurface,
		severity: 'info' as const,
		message: 'Кремово-бежевый фон крупной поверхности',
		why: 'Тёплый off-white берут «на всякий случай», когда фон не выбирали — он безопасен и потому безлик.',
		selector: el.selector,
		evidence: `background rgb(${el.backgroundColor.join(',')})`,
	}));

/**
 * Text over a gradient or an image: the ratio cannot be computed from the page, so it is reported
 * as unmeasured instead of being measured against a white that is not there.
 */
const ruleContrastUnmeasurable: Rule = doc => {
	const texts = doc.elements.filter(el => el.text.length > 0 && el.backgroundUnmeasurable && el.backgroundClip !== 'text');
	const why = 'Под текстом картинка или градиент: контраст по ним не посчитать, а тёмный текст на тёмном участке фото пропадает. Проверьте глазами на самом тёмном и самом светлом месте или подложите сплошной цвет.';
	if (texts.length <= MAX_UNMEASURABLE_PER_ELEMENT) {
		return texts.map((el): RuleFinding => ({
			rule: RULE.contrastUnmeasurable,
			severity: 'warning',
			message: 'Контраст не измерить: текст на картинке или градиенте',
			why,
			selector: el.selector,
			evidence: `цвет ${el.color.join(',')}, фон — изображение`,
		}));
	}
	return [{
		rule: RULE.contrastUnmeasurable,
		severity: 'warning',
		message: `Контраст не измерить у ${texts.length} текстов: под ними картинка или градиент`,
		why,
		selector: texts[0].selector,
		evidence: texts.slice(0, 3).map(el => el.selector).join('; '),
	}];
};

/** The colour a control shows as its accent: its own fill, else a visible border, else its text. */
const accentOf = (el: ElementSnapshot): [number, number, number] => {
	if (el.ownBackgroundAlpha > 0.5) { return el.backgroundColor; }
	const border = Math.max(el.borderWidthPx.top, el.borderWidthPx.right, el.borderWidthPx.bottom, el.borderWidthPx.left);
	return border >= 1 && el.borderAlpha > 0.5 ? el.borderColor : el.color;
};

/**
 * A destructive action painted with a saturated non-danger colour: the blue «Delete».
 *
 * Read from the rendered accent, not from a class name — a `btn-danger` wired to a blue token is
 * exactly the case. A neutral (grey, outline in text colour) destructive control is not flagged: the
 * defect is promising safety, not declining to be red.
 */
const ruleDestructiveWrongIntent: Rule = doc => doc.elements
	.filter(el => el.interactive && !el.disabled)
	.filter(el => {
		const label = (el.accessibleName || el.text).toLowerCase();
		return DESTRUCTIVE_LABEL_EN.test(label) || DESTRUCTIVE_LABEL_RU.test(label);
	})
	.map(el => ({ el, accent: accentOf(el) }))
	.filter(({ accent }) => {
		const { hue, saturation } = hueSaturation(accent);
		const light = lightness(accent);
		return saturation >= ACCENT_MIN_SATURATION
			&& light >= ACCENT_LIGHTNESS_RANGE[0] && light <= ACCENT_LIGHTNESS_RANGE[1]
			&& hue > DANGER_HUE_MAX && hue < DANGER_HUE_MIN;
	})
	.map(({ el, accent }) => ({
		rule: RULE.destructiveWrongIntent,
		severity: 'warning' as const,
		message: `Разрушающее действие «${(el.accessibleName || el.text).slice(0, 40)}» в неопасном цвете`,
		why: 'Насыщенный не-красный цвет обещает безопасное основное действие; удаление в нём нажимают по привычке.',
		selector: el.selector,
		evidence: `акцент rgb(${accent.join(',')}), оттенок ${Math.round(hueSaturation(accent).hue)}°`,
	}));

/** Body text in pure #000 on a near-white page: the value nobody chose. */
const rulePureBlackText: Rule = doc => {
	const texts = doc.elements.filter(el => isBodyText(el)
		&& el.color[0] === 0 && el.color[1] === 0 && el.color[2] === 0
		&& lightness(el.backgroundColor) >= PURE_BLACK_SURFACE_MIN_LIGHTNESS);
	if (texts.length === 0) { return []; }
	return [{
		rule: RULE.pureBlackText,
		severity: 'info',
		message: `Основной текст чисто чёрный (#000) на светлом фоне — ${texts.length} блок(ов)`,
		why: 'Чистый чёрный на белом режет глаз сильнее, чем нужно для чтения; выбранная палитра обычно берёт тонированный почти-чёрный.',
		selector: texts[0].selector,
		evidence: `color rgb(0,0,0) на rgb(${texts[0].backgroundColor.join(',')})`,
	}];
};

export const COLOR_RULES: readonly Rule[] = [
	ruleLowContrast,
	ruleGradientText,
	ruleAiViolet,
	ruleDarkGlow,
	ruleRadialHalo,
	ruleBeigeSurface,
	ruleContrastUnmeasurable,
	ruleDestructiveWrongIntent,
	rulePureBlackText,
];
