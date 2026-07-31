/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Colour rules: readability first, then the palettes that arrive by reflex. */

import { ElementSnapshot, Rule, contrastRatio, hueSaturation, lightness } from '../designSnapshot.js';
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

const requiredContrastFor = (el: ElementSnapshot): number =>
	el.fontSizePx >= LARGE_TEXT_PX || (el.fontWeight >= 700 && el.fontSizePx >= LARGE_TEXT_BOLD_PX)
		? MIN_CONTRAST_LARGE
		: MIN_CONTRAST_NORMAL;

const ruleLowContrast: Rule = doc => doc.elements
	.filter(el => el.text.length > 0)
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

export const COLOR_RULES: readonly Rule[] = [
	ruleLowContrast,
	ruleGradientText,
	ruleAiViolet,
	ruleDarkGlow,
	ruleRadialHalo,
	ruleBeigeSurface,
];
