/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Surface decoration: borders, blur, stripes, radii.
 *
 * Each of these is a device applied to a box to make it look designed. One is a choice; five on a
 * page is a signature.
 */

import { ElementSnapshot, Rule, contrastRatio } from '../designSnapshot.js';
import { RULE } from '../ruleIds.js';

/** Radius above which a small card reads as a lozenge rather than a card. */
const EXTREME_RADIUS_PX = 24;
/** Cards below this size are the ones where a 24px radius eats the corner content. */
const SMALL_CARD_MAX_WIDTH_PX = 420;
/** A hairline is thin enough that it is meant as an edge, not as a frame. */
const HAIRLINE_MAX_WIDTH_PX = 1.5;
/** A shadow blur this wide is "soft elevation" — combined with a hairline it double-states the edge. */
const WIDE_SHADOW_BLUR_PX = 12;
/** A side accent is several times thicker than the other sides. */
const SIDE_ACCENT_MIN_WIDTH_PX = 3;
const SIDE_ACCENT_RATIO = 3;
/** Blur radius from which a backdrop filter is the glassmorphism effect rather than a nudge. */
const GLASS_MIN_BLUR_PX = 4;
/** A decorative background needs to be big enough to be a background. */
const BACKDROP_MIN_WIDTH_PX = 400;
const BACKDROP_MIN_HEIGHT_PX = 300;
/** Shape count from which an inline SVG stops being an icon and becomes an illustration. */
const ILLUSTRATION_MIN_SHAPES = 8;
/** A hero illustration occupies real estate; below this it is decoration. */
const ILLUSTRATION_MIN_WIDTH_PX = 200;
/** Border colour close to the surface it sits on: a frame nobody sees, drawn out of habit. */
const INVISIBLE_BORDER_MAX_CONTRAST = 1.12;

const maxBorder = (el: ElementSnapshot): number =>
	Math.max(el.borderWidthPx.top, el.borderWidthPx.right, el.borderWidthPx.bottom, el.borderWidthPx.left);

const totalBorder = (el: ElementSnapshot): number =>
	el.borderWidthPx.top + el.borderWidthPx.right + el.borderWidthPx.bottom + el.borderWidthPx.left;

const shadowBlurPx = (boxShadow: string): number => {
	// `0px 4px 12px rgba(…)` — the third length is the blur; colours are stripped first so the
	// numbers inside rgba() cannot be mistaken for lengths.
	const lengths = boxShadow.replace(/rgba?\([^)]*\)/g, '').match(/-?\d+(?:\.\d+)?px/g);
	return lengths && lengths.length >= 3 ? Math.abs(parseFloat(lengths[2])) : 0;
};

const ruleExtremeRadius: Rule = doc => doc.elements
	.filter(el => el.borderRadiusPx >= EXTREME_RADIUS_PX && el.widthPx <= SMALL_CARD_MAX_WIDTH_PX)
	// Pills are legitimate for tags and buttons: a fully rounded short control is a shape, not drift.
	.filter(el => !el.interactive && el.heightPx > el.borderRadiusPx * 2)
	.map(el => ({
		rule: RULE.extremeRadius,
		severity: 'info' as const,
		message: `Радиус ${el.borderRadiusPx.toFixed(0)}px на карточке ${el.widthPx.toFixed(0)}px`,
		why: 'Сильное скругление на небольшой карточке съедает углы и уводит внимание с содержимого; для карточек хватает 12–16px.',
		selector: el.selector,
		evidence: `border-radius: ${el.borderRadiusPx.toFixed(0)}px при ширине ${el.widthPx.toFixed(0)}px`,
	}));


/**
 * Сколько РАЗНЫХ радиусов скругления живёт на одной странице.
 *
 * Это измеримая форма правила «значение, которое повторяется, выносится в токен», вывернутая с той
 * стороны, которую видно на готовой странице: если радиусов шесть и все разные, значит шкалы нет и
 * каждый элемент решал за себя. Ровно так выглядит интерфейс, собранный по частям — глазу он
 * кажется неаккуратным, но причину без замера не назвать, потому что каждый радиус по отдельности
 * выглядит нормально.
 *
 * Ноль не считается: прямые углы — это осознанное решение, а не ещё одна ступень шкалы. Мелочь
 * вроде 1–3px тоже пропускается: такие значения приходят от бордеров и артефактов округления,
 * а не от чьего-то выбора.
 */
const ruleRadiusScaleSprawl: Rule = doc => {
	const MIN_RADIUS_PX = 4;
	const MAX_DISTINCT = 5;
	const MIN_ELEMENTS = 8;
	const boxes = doc.elements.filter(el =>
		el.borderRadiusPx >= MIN_RADIUS_PX && el.widthPx >= 40 && el.heightPx >= 24);
	if (boxes.length < MIN_ELEMENTS) { return []; }
	// Округление до целого: 11.98px и 12px — одна ступень, различие пришло от вычисленной ширины.
	const distinct = [...new Set(boxes.map(el => Math.round(el.borderRadiusPx)))].sort((a, b) => a - b);
	if (distinct.length <= MAX_DISTINCT) { return []; }
	return [{
		rule: RULE.radiusScaleSprawl,
		severity: 'info',
		message: `${distinct.length} разных радиусов скругления на странице: ${distinct.join(', ')}px`,
		why: 'Шкала радиусов — такой же токен, как цвет: две-три ступени на продукт. Когда их шесть и больше, значение выбиралось каждый раз заново, и страница выглядит собранной по частям.',
		selector: 'body',
		evidence: `${distinct.length} значений на ${boxes.length} элементах: ${distinct.join(', ')}px`,
	}];
};

/** A thin border AND a wide soft shadow: the edge is stated twice, in two different languages. */
const ruleHairlineWithShadow: Rule = doc => doc.elements
	.filter(el => el.borderAlpha > 0.05 && maxBorder(el) > 0 && maxBorder(el) <= HAIRLINE_MAX_WIDTH_PX)
	.filter(el => shadowBlurPx(el.boxShadow) >= WIDE_SHADOW_BLUR_PX)
	.map(el => ({
		rule: RULE.hairlineWithShadow,
		severity: 'info' as const,
		message: 'Тонкая рамка и широкая тень одновременно',
		why: 'Край задан дважды: рамка говорит «здесь граница», размытая тень — «здесь возвышение». Нужно выбрать одно.',
		selector: el.selector,
		evidence: `border ${maxBorder(el)}px + blur ${shadowBlurPx(el.boxShadow).toFixed(0)}px`,
	}));

/** One thick coloured side on a card — the "side-tab accent" every generator adds. */
const ruleSideAccentBorder: Rule = doc => doc.elements
	.filter(el => el.borderAlpha > 0.2)
	.map(el => {
		const sides = [
			{ name: 'сверху', value: el.borderWidthPx.top },
			{ name: 'справа', value: el.borderWidthPx.right },
			{ name: 'снизу', value: el.borderWidthPx.bottom },
			{ name: 'слева', value: el.borderWidthPx.left },
		];
		const thickest = sides.reduce((max, side) => side.value > max.value ? side : max, sides[0]);
		const others = sides.filter(side => side !== thickest).map(side => side.value);
		return { el, thickest, rest: Math.max(...others) };
	})
	.filter(({ thickest, rest }) => thickest.value >= SIDE_ACCENT_MIN_WIDTH_PX && thickest.value >= Math.max(1, rest) * SIDE_ACCENT_RATIO)
	.map(({ el, thickest }) => ({
		rule: RULE.sideAccentBorder,
		severity: 'info' as const,
		message: `Толстая цветная полоса ${thickest.name} у блока`,
		why: 'Акцентная полоса с одной стороны имитирует смысловую метку, которой в интерфейсе нет.',
		selector: el.selector,
		evidence: `border-width ${thickest.value}px ${thickest.name}, остальные тоньше`,
	}));

/** Blur behind a translucent surface, applied as decoration rather than to solve layering. */
const ruleGlassmorphism: Rule = doc => doc.elements
	.filter(el => /blur\(\s*(\d+(?:\.\d+)?)px/.test(el.backdropFilter))
	.filter(el => {
		const blur = parseFloat(/blur\(\s*(\d+(?:\.\d+)?)px/.exec(el.backdropFilter)?.[1] ?? '0');
		return blur >= GLASS_MIN_BLUR_PX;
	})
	.map(el => ({
		rule: RULE.glassmorphism,
		severity: 'info' as const,
		message: 'Размытие фона под полупрозрачной поверхностью',
		why: 'Стеклянная карточка ради вида: слоистость решается порядком и контрастом, а не блюром на каждой панели.',
		selector: el.selector,
		evidence: el.backdropFilter,
	}));

/** A grid or stripes painted into the background of a big block, with no structural counterpart. */
const ruleDecorativeBackdrop: Rule = doc => doc.elements
	.filter(el => el.widthPx >= BACKDROP_MIN_WIDTH_PX && el.heightPx >= BACKDROP_MIN_HEIGHT_PX)
	.map(el => ({
		el,
		kind: /repeating-linear-gradient|repeating-radial-gradient/.test(el.backgroundImage) ? 'stripes'
			: /linear-gradient\([^)]*\)\s*,\s*linear-gradient/.test(el.backgroundImage) ? 'grid'
				: undefined,
	}))
	.filter((pair): pair is { el: ElementSnapshot; kind: string } => !!pair.kind)
	.map(({ el, kind }) => ({
		rule: kind === 'stripes' ? RULE.repeatingGradientStripes : RULE.decorativeGridBackground,
		severity: 'info' as const,
		message: kind === 'stripes' ? 'Повторяющиеся градиентные полосы на фоне' : 'Декоративная сетка на фоне блока',
		why: 'Фоновая сетка и полосы имитируют «инженерную» структуру, которой в раскладке нет: настоящая структура задаётся содержимым.',
		selector: el.selector,
		evidence: el.backgroundImage.slice(0, 80),
	}));

/** Hero art assembled from a pile of primitive shapes — placeholder clip art with extra steps. */
const ruleShapeAssembledArt: Rule = doc => doc.elements
	.filter(el => el.svgShapeCount >= ILLUSTRATION_MIN_SHAPES && el.widthPx >= ILLUSTRATION_MIN_WIDTH_PX)
	.map(el => ({
		rule: RULE.shapeAssembledArt,
		severity: 'info' as const,
		message: `Иллюстрация из ${el.svgShapeCount} примитивов`,
		why: 'Картинка, собранная из кругов и прямоугольников, читается как заглушка — лучше настоящий ассет или ничего.',
		selector: el.selector,
		evidence: `${el.svgShapeCount} фигур в inline-SVG, ${el.widthPx.toFixed(0)}px шириной`,
	}));

/** A border whose colour is indistinguishable from what it sits on. */
const ruleInvisibleBorder: Rule = doc => doc.elements
	.filter(el => el.borderAlpha > 0.9 && totalBorder(el) > 0)
	.filter(el => contrastRatio(el.borderColor, el.backgroundColor) <= INVISIBLE_BORDER_MAX_CONTRAST)
	.map(el => ({
		rule: RULE.invisibleBorder,
		severity: 'info' as const,
		message: 'Рамка почти не отличается от фона',
		why: 'Невидимая рамка занимает пиксели и ничего не разделяет — либо усилить, либо убрать.',
		selector: el.selector,
		evidence: `рамка rgb(${el.borderColor.join(',')}) на фоне rgb(${el.backgroundColor.join(',')})`,
	}));

export const VISUAL_RULES: readonly Rule[] = [
	ruleExtremeRadius,
	ruleRadiusScaleSprawl,
	ruleHairlineWithShadow,
	ruleSideAccentBorder,
	ruleGlassmorphism,
	ruleDecorativeBackdrop,
	ruleShapeAssembledArt,
	ruleInvisibleBorder,
];
