/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Motion rules: movement that is not reporting a change.
 *
 * Animation earns its place when something actually happened. A pulse on a static status, a caret
 * in text nobody can edit, a marquee that hides what it carries — these move to look alive.
 */

import { Rule } from '../designSnapshot.js';
import { RULE } from '../ruleIds.js';

/** Names generators reach for when the brief was "make it feel alive". */
const DECORATIVE_ANIMATION_NAMES = /pulse|blink|marquee|bounce|float|shimmer|glow|wiggle|breath/i;
/** Easing curves that overshoot: dated on interface elements, fine in a game. */
const ELASTIC_EASING = /cubic-bezier\(\s*[^)]*\)/;
/** Properties whose animation forces layout on every frame. */
const LAYOUT_PROPERTIES = ['width', 'height', 'padding', 'margin', 'top', 'left', 'right', 'bottom'];

/** An overshooting cubic-bezier has a control point outside 0..1 on the output axis. */
const overshoots = (timing: string): boolean => {
	const match = ELASTIC_EASING.exec(timing);
	if (!match) { return false; }
	const values = match[0].replace(/cubic-bezier\(|\)/g, '').split(',').map(part => parseFloat(part.trim()));
	if (values.length !== 4 || values.some(value => !isFinite(value))) { return false; }
	return values[1] < -0.01 || values[1] > 1.01 || values[3] < -0.01 || values[3] > 1.01;
};

const ruleDecorativeAnimation: Rule = doc => doc.elements
	.filter(el => DECORATIVE_ANIMATION_NAMES.test(el.animationName))
	.map(el => ({
		rule: RULE.decorativeAnimation,
		severity: 'info' as const,
		message: `Декоративная анимация «${el.animationName}»`,
		why: 'Постоянное движение перетягивает внимание с содержимого и не выключается по желанию читателя.',
		selector: el.selector,
		evidence: `animation-name: ${el.animationName}`,
	}));

/** Bounce and elastic easing on interface elements. */
const ruleElasticEasing: Rule = doc => doc.elements
	.filter(el => el.animationDurationMs > 0 && overshoots(el.animationTimingFunction))
	.map(el => ({
		rule: RULE.elasticEasing,
		severity: 'info' as const,
		message: 'Анимация с перелётом (bounce/elastic)',
		why: 'Отскок на элементах интерфейса читается как «сделано весело», а не «сделано точно»: для UI берут ease-out без перелёта.',
		selector: el.selector,
		evidence: `animation-timing-function: ${el.animationTimingFunction}`,
	}));

/** Animating geometry instead of transform: the browser relayouts every frame. */
const ruleLayoutPropertyAnimation: Rule = doc => doc.elements
	.filter(el => el.transitionProperty && el.transitionProperty !== 'none' && el.transitionProperty !== 'all')
	.map(el => ({
		el,
		hits: el.transitionProperty.split(',')
			.map(part => part.trim().toLowerCase())
			.filter(property => LAYOUT_PROPERTIES.includes(property)),
	}))
	.filter(({ hits }) => hits.length > 0)
	.map(({ el, hits }) => ({
		rule: RULE.layoutPropertyAnimation,
		severity: 'warning' as const,
		message: `Анимируются свойства раскладки: ${hits.join(', ')}`,
		why: 'Каждый кадр такой анимации пересчитывает раскладку — движение дёргается; то же самое делают transform и opacity без пересчёта.',
		selector: el.selector,
		evidence: `transition-property: ${el.transitionProperty}`,
	}));

export const MOTION_RULES: readonly Rule[] = [
	ruleDecorativeAnimation,
	ruleElasticEasing,
	ruleLayoutPropertyAnimation,
];
