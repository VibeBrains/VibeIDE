/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Copy rules: the interface text, judged as text.
 *
 * Only tells that survive as measurement: word lists and templates, punctuation density, repetition.
 * Rhythm and voice ("aphoristic cadence") are real tells but not measurable on one line of a page —
 * they live in the `anti-slop` skill, where a human or a model reads for them instead of a regex
 * pretending to.
 */

import { DocumentSnapshot, RuleFinding, Rule } from '../designSnapshot.js';
import { RULE } from '../ruleIds.js';
import { slopSeverityRank } from '../../textSlop/slopCatalog.js';
import { analyzeTextSlop, SlopFinding } from '../../textSlop/textSlop.js';

/** Pictographs; ©, ® and ™ are Extended_Pictographic too, but they are typography, not icons. */
const EMOJI = /\p{Extended_Pictographic}/u;
const TYPOGRAPHIC_SYMBOLS = /[\u00a9\u00ae\u2122]/gu;

/** Dismissing something as "theatre" — a recurring generated-copy tic. */
const THEATRE_FRAMING = /\b(?:security|compliance|productivity|innovation)\s+theat(?:er|re)\b|\bтеатр\s+(?:безопасности|продуктивности|соответствия)/i;

/** Text below this length is a label; em-dash density there means nothing. */
const EM_DASH_MIN_TEXT = 120;
/** Repeated inside one container from this count on it is a copy-paste, not emphasis. */
const REPEAT_MIN = 2;
/** Short strings repeat legitimately (units, "да"/"нет"); only real phrases count. */
const REPEAT_MIN_TEXT_LENGTH = 12;

/**
 * Stock copy on the page: the text-slop catalogue over every text the page shows — the same lists the prose
 * check and VibeIDEA use, so a headline and a README are held to one standard. One finding per element, for
 * its heaviest tell: a headline with three tells is one headline to rewrite.
 */
const ruleCopySlop: Rule = (doc, inputs) => {
	const catalog = inputs?.pageSlop;
	if (!catalog) {
		return [];
	}
	const findings: RuleFinding[] = [];
	for (const el of doc.elements) {
		if (el.text.trim().length === 0) {
			continue;
		}
		let heaviest: SlopFinding | undefined;
		for (const finding of analyzeTextSlop(el.text, catalog).findings) {
			if (!heaviest || slopSeverityRank(finding.severity) > slopSeverityRank(heaviest.severity)) {
				heaviest = finding;
			}
		}
		if (heaviest) {
			findings.push({
				rule: RULE.copySlop,
				severity: 'info',
				message: `Шаблонный текст: ${heaviest.name}`,
				why: 'Приметы машинного письма в тексте страницы ничего не сообщают о продукте и читаются как заглушка. Каталог тот же, что у проверки текста; правила проекта — в .vibe/slop.json.',
				selector: el.selector,
				evidence: heaviest.fix ? `«${heaviest.match}» — ${heaviest.fix}` : `«${heaviest.match}»`,
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

/** Emoji standing in for icons on controls and headings. */
const ruleEmojiAsIcon: Rule = doc => doc.elements
	.filter(el => el.interactive || /^h[1-6]$/.test(el.tag))
	.filter(el => EMOJI.test(el.text.replace(TYPOGRAPHIC_SYMBOLS, '')))
	.map(el => ({
		rule: RULE.emojiAsIcon,
		severity: 'info' as const,
		message: `Эмодзи вместо иконки: «${el.text.slice(0, 40)}»`,
		why: 'Эмодзи рисует система, а не продукт: на каждой платформе он свой, а программа чтения зачитывает его название посреди подписи.',
		selector: el.selector,
		evidence: el.text.slice(0, 60),
	}));

export const COPY_RULES: readonly Rule[] = [
	ruleCopySlop,
	ruleEmDashOveruse,
	ruleTheatreFraming,
	ruleRepeatedTextInContainer,
	ruleEmojiAsIcon,
];
