/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Copy rules: the interface text, judged as text.
 *
 * Only tells that survive as measurement: word lists, punctuation density, repetition. Rhythm and
 * voice ("aphoristic cadence") are real tells but not measurable — they live in the skill's
 * checklist, where a human or a model reads for them instead of a regex pretending to.
 */

import { DocumentSnapshot, RuleFinding, Rule } from '../designSnapshot.js';
import { RULE } from '../ruleIds.js';

/** Words that promise instead of saying. Matched whole-word, case-insensitive. */
const MARKETING_FILLER = [
	'revolutionary', 'seamless', 'unleash', 'game-changing', 'cutting-edge', 'next-level',
	'elevate', 'supercharge', 'effortlessly', 'unlock the power', 'take it to the next level',
	'streamline', 'empower', 'world-class', 'enterprise-grade',
	'революционн', 'инновационн', 'непревзойдённ', 'уникальн в своём роде', 'на новый уровень',
	'мирового уровня', 'корпоративного уровня', 'раскройте потенциал',
];

/** Dismissing something as "theatre" — a recurring generated-copy tic. */
const THEATRE_FRAMING = /\b(?:security|compliance|productivity|innovation)\s+theat(?:er|re)\b|\bтеатр\s+(?:безопасности|продуктивности|соответствия)/i;

/** Text below this length is a label; em-dash density there means nothing. */
const EM_DASH_MIN_TEXT = 120;
/** Repeated inside one container from this count on it is a copy-paste, not emphasis. */
const REPEAT_MIN = 2;
/** Short strings repeat legitimately (units, "да"/"нет"); only real phrases count. */
const REPEAT_MIN_TEXT_LENGTH = 12;

const ruleMarketingFiller: Rule = doc => {
	const findings: RuleFinding[] = [];
	for (const el of doc.elements) {
		if (el.text.length < 8) { continue; }
		const lower = el.text.toLowerCase();
		const hit = MARKETING_FILLER.find(word => lower.includes(word));
		if (hit) {
			findings.push({
				rule: RULE.marketingFiller,
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
	.filter(el => el.text.length >= EM_DASH_MIN_TEXT)
	.map(el => ({ el, count: (el.text.match(/—/g) ?? []).length }))
	// Two or more per 120 characters reads as generated prose rather than written.
	.filter(({ el, count }) => count >= 2 && count / (el.text.length / EM_DASH_MIN_TEXT) >= 2)
	.map(({ el, count }) => ({
		rule: RULE.emDashOveruse,
		severity: 'info' as const,
		message: `Тире ${count} раз в одном абзаце`,
		why: 'Плотность длинных тире — самый заметный след текста, написанного моделью.',
		selector: el.selector,
		evidence: el.text.slice(0, 80),
	}));

const ruleTheatreFraming: Rule = doc => doc.elements
	.filter(el => THEATRE_FRAMING.test(el.text))
	.map(el => ({
		rule: RULE.theatreFraming,
		severity: 'info' as const,
		message: 'Оборот «...театр» в тексте интерфейса',
		why: 'Обесценивание чужого через «это театр» — характерный тик сгенерированного копирайта; лучше прямо сказать, что продукт делает и чего не делает.',
		selector: el.selector,
		evidence: el.text.slice(0, 80),
	}));

/** The same phrase filled into several slots of one card. */
const ruleRepeatedTextInContainer: Rule = (doc: DocumentSnapshot) => {
	const byParent = new Map<string, Map<string, string[]>>();
	for (const el of doc.elements) {
		const text = el.text.trim();
		if (text.length < REPEAT_MIN_TEXT_LENGTH || !el.parentSelector) { continue; }
		const perParent = byParent.get(el.parentSelector) ?? new Map<string, string[]>();
		const selectors = perParent.get(text) ?? [];
		selectors.push(el.selector);
		perParent.set(text, selectors);
		byParent.set(el.parentSelector, perParent);
	}
	const findings: RuleFinding[] = [];
	for (const [parent, perParent] of byParent) {
		for (const [text, selectors] of perParent) {
			if (selectors.length <= REPEAT_MIN) { continue; }
			findings.push({
				rule: RULE.repeatedText,
				severity: 'warning',
				message: `Текст «${text.slice(0, 30)}» повторён ${selectors.length} раза в одном блоке`,
				why: 'Одна и та же надпись в нескольких слотах — признак того, что данные не подставились или шаблон заполнили заглушкой.',
				selector: parent,
				evidence: selectors.slice(0, 3).join(', '),
			});
		}
	}
	return findings;
};

export const COPY_RULES: readonly Rule[] = [
	ruleMarketingFiller,
	ruleEmDashOveruse,
	ruleTheatreFraming,
	ruleRepeatedTextInContainer,
];
