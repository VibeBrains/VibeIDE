/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The catalogue: every finding id, its class and its category, as data.
 *
 * Why a registry and not literals inside the rules: a project accepts drift by writing rule ids
 * into its `design.md`, and a typo there silently switches off nothing — the project believes a
 * finding is accepted while the detector keeps reporting it. The doctor can only catch that against
 * a list, and the list must not be a second hand-maintained copy of the ids, so the rules take
 * their ids FROM here.
 *
 * `floor` never becomes acceptable: contrast, hit targets, heading order, clipping, missing images.
 * `drift` is a style tell — true by default, and a deliberate identity when the project says so.
 */

import { RuleClass } from './designSnapshot.js';

export const RULE = {
	// typography
	tinyText: 'tiny-text',
	undersizedUiText: 'undersized-ui-text',
	tightLeading: 'tight-leading',
	allCapsBody: 'all-caps-body',
	wideTracking: 'wide-tracking',
	extremeNegativeTracking: 'extreme-negative-tracking',
	flatTypeHierarchy: 'flat-type-hierarchy',
	skippedHeading: 'skipped-heading',
	oversizedH1: 'oversized-h1',
	singleFont: 'single-font',
	kickerLabel: 'kicker-label',
	iconTileAboveHeading: 'icon-tile-above-heading',
	italicSerifHero: 'italic-serif-hero',
	oversizedHeadlineCopy: 'oversized-headline-copy',
	overusedFont: 'overused-font',
	justifiedText: 'justified-text',
	hangingPreposition: 'hanging-preposition',
	orphanWord: 'orphan-word',

	// colour and contrast
	lowContrast: 'low-contrast',
	gradientText: 'gradient-text',
	aiColorPalette: 'ai-color-palette',
	darkGlow: 'dark-glow',
	radialHalo: 'radial-halo',
	beigeSurface: 'beige-surface',

	// surface decoration
	extremeRadius: 'extreme-radius',
	hairlineWithShadow: 'hairline-with-shadow',
	sideAccentBorder: 'side-accent-border',
	glassmorphism: 'glassmorphism',
	repeatingGradientStripes: 'repeating-gradient-stripes',
	decorativeGridBackground: 'decorative-grid-background',
	shapeAssembledArt: 'shape-assembled-art',
	invisibleBorder: 'invisible-border',

	// состояния интерактивных элементов
	focusNotVisible: 'focus-not-visible',
	disabledIndistinguishable: 'disabled-indistinguishable',
	noHoverAffordance: 'no-hover-affordance',

	// layout and space
	lineLength: 'line-length',
	crampedTarget: 'cramped-target',
	nestedCards: 'nested-cards',
	contentOverflow: 'content-overflow',
	pageOverflow: 'page-overflow',
	clippedPositionedChild: 'clipped-positioned-child',
	occludedText: 'occluded-text',
	identicalCards: 'identical-cards',
	monotonousSpacing: 'monotonous-spacing',
	heroMetrics: 'hero-metrics',
	numberedSectionLabel: 'numbered-section-label',
	columnImbalance: 'column-imbalance',
	headingCrowded: 'heading-crowded',
	flushToScrollerEdge: 'flush-to-scroller-edge',

	// motion
	decorativeAnimation: 'decorative-animation',
	elasticEasing: 'elastic-easing',
	layoutPropertyAnimation: 'layout-property-animation',

	// copy
	marketingFiller: 'marketing-filler',
	emDashOveruse: 'em-dash-overuse',
	theatreFraming: 'theatre-framing',
	repeatedText: 'repeated-text',

	// imagery
	brokenImage: 'broken-image',
	placeholderImage: 'placeholder-image',
} as const;

export type RuleId = typeof RULE[keyof typeof RULE];

/** Categories, in the order a report reads best: readability first, taste last. */
export type RuleCategory = 'typography' | 'color' | 'visual' | 'layout' | 'motion' | 'copy' | 'imagery' | 'states';

interface RuleMeta {
	readonly ruleClass: RuleClass;
	readonly category: RuleCategory;
}

export const RULE_META: Record<RuleId, RuleMeta> = {
	[RULE.tinyText]: { ruleClass: 'floor', category: 'typography' },
	[RULE.undersizedUiText]: { ruleClass: 'floor', category: 'typography' },
	[RULE.tightLeading]: { ruleClass: 'drift', category: 'typography' },
	[RULE.allCapsBody]: { ruleClass: 'drift', category: 'typography' },
	[RULE.wideTracking]: { ruleClass: 'drift', category: 'typography' },
	[RULE.extremeNegativeTracking]: { ruleClass: 'drift', category: 'typography' },
	[RULE.flatTypeHierarchy]: { ruleClass: 'drift', category: 'typography' },
	[RULE.skippedHeading]: { ruleClass: 'floor', category: 'typography' },
	[RULE.oversizedH1]: { ruleClass: 'drift', category: 'typography' },
	[RULE.singleFont]: { ruleClass: 'drift', category: 'typography' },
	[RULE.kickerLabel]: { ruleClass: 'drift', category: 'typography' },
	[RULE.iconTileAboveHeading]: { ruleClass: 'drift', category: 'typography' },
	[RULE.italicSerifHero]: { ruleClass: 'drift', category: 'typography' },
	[RULE.oversizedHeadlineCopy]: { ruleClass: 'drift', category: 'typography' },
	[RULE.overusedFont]: { ruleClass: 'drift', category: 'typography' },
	[RULE.justifiedText]: { ruleClass: 'drift', category: 'typography' },
	[RULE.hangingPreposition]: { ruleClass: 'drift', category: 'typography' },
	[RULE.orphanWord]: { ruleClass: 'drift', category: 'typography' },

	[RULE.lowContrast]: { ruleClass: 'floor', category: 'color' },
	[RULE.gradientText]: { ruleClass: 'drift', category: 'color' },
	[RULE.aiColorPalette]: { ruleClass: 'drift', category: 'color' },
	[RULE.darkGlow]: { ruleClass: 'drift', category: 'color' },
	[RULE.radialHalo]: { ruleClass: 'drift', category: 'color' },
	[RULE.beigeSurface]: { ruleClass: 'drift', category: 'color' },

	[RULE.extremeRadius]: { ruleClass: 'drift', category: 'visual' },
	[RULE.hairlineWithShadow]: { ruleClass: 'drift', category: 'visual' },
	[RULE.sideAccentBorder]: { ruleClass: 'drift', category: 'visual' },
	[RULE.glassmorphism]: { ruleClass: 'drift', category: 'visual' },
	[RULE.repeatingGradientStripes]: { ruleClass: 'drift', category: 'visual' },
	[RULE.decorativeGridBackground]: { ruleClass: 'drift', category: 'visual' },
	[RULE.shapeAssembledArt]: { ruleClass: 'drift', category: 'visual' },
	[RULE.invisibleBorder]: { ruleClass: 'drift', category: 'visual' },
	// Фокус и различимость выключенного — пол качества: без них интерфейс нельзя пройти с
	// клавиатуры и нельзя понять, почему кнопка не срабатывает. Отклик на наведение —
	// вопрос вкуса и устройства ввода, поэтому drift.
	[RULE.focusNotVisible]: { ruleClass: 'floor', category: 'states' },
	[RULE.disabledIndistinguishable]: { ruleClass: 'floor', category: 'states' },
	[RULE.noHoverAffordance]: { ruleClass: 'drift', category: 'states' },

	[RULE.lineLength]: { ruleClass: 'drift', category: 'layout' },
	[RULE.crampedTarget]: { ruleClass: 'floor', category: 'layout' },
	[RULE.nestedCards]: { ruleClass: 'drift', category: 'layout' },
	[RULE.contentOverflow]: { ruleClass: 'floor', category: 'layout' },
	[RULE.pageOverflow]: { ruleClass: 'floor', category: 'layout' },
	[RULE.clippedPositionedChild]: { ruleClass: 'floor', category: 'layout' },
	[RULE.occludedText]: { ruleClass: 'floor', category: 'layout' },
	[RULE.identicalCards]: { ruleClass: 'drift', category: 'layout' },
	[RULE.monotonousSpacing]: { ruleClass: 'drift', category: 'layout' },
	[RULE.heroMetrics]: { ruleClass: 'drift', category: 'layout' },
	[RULE.numberedSectionLabel]: { ruleClass: 'drift', category: 'layout' },
	[RULE.columnImbalance]: { ruleClass: 'drift', category: 'layout' },
	[RULE.headingCrowded]: { ruleClass: 'drift', category: 'layout' },
	[RULE.flushToScrollerEdge]: { ruleClass: 'drift', category: 'layout' },

	[RULE.decorativeAnimation]: { ruleClass: 'drift', category: 'motion' },
	[RULE.elasticEasing]: { ruleClass: 'drift', category: 'motion' },
	[RULE.layoutPropertyAnimation]: { ruleClass: 'drift', category: 'motion' },

	[RULE.marketingFiller]: { ruleClass: 'drift', category: 'copy' },
	[RULE.emDashOveruse]: { ruleClass: 'drift', category: 'copy' },
	[RULE.theatreFraming]: { ruleClass: 'drift', category: 'copy' },
	[RULE.repeatedText]: { ruleClass: 'drift', category: 'copy' },

	[RULE.brokenImage]: { ruleClass: 'floor', category: 'imagery' },
	[RULE.placeholderImage]: { ruleClass: 'drift', category: 'imagery' },
};

/** Every id the catalogue can report. */
export const ALL_RULE_IDS: readonly RuleId[] = Object.keys(RULE_META) as RuleId[];

/** Ids a project may declare deliberate; the floor is deliberately absent. */
export const ACCEPTABLE_RULE_IDS: readonly RuleId[] =
	ALL_RULE_IDS.filter(id => RULE_META[id].ruleClass === 'drift');

export const classOf = (rule: string): RuleClass | undefined =>
	(RULE_META as Record<string, RuleMeta | undefined>)[rule]?.ruleClass;
