/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Разметка: то, что читает не глаз, а программа чтения с экрана.
 *
 * Отличие от всех остальных категорий в том, что эти дефекты **не видны на скриншоте**. Кнопка
 * с одной иконкой выглядит опрятно и молчит для того, кто её не видит. Поле с плейсхолдером
 * вместо подписи выглядит аккуратно ровно до первого введённого символа, после чего человек
 * забывает, что от него хотели. Ни дизайнер, ни агент этого не заметят, глядя на картинку.
 *
 * Слой подсказан по-компонентными чек-листами: у каждого поля ввода там первым пунктом стоит
 * подпись, у каждого управляющего элемента — имя. Формулировки и пороги наши.
 *
 * Всё здесь — пол качества: доступность не бывает вопросом вкуса проекта.
 */

import { ElementSnapshot, Rule } from '../designSnapshot.js';
import { RULE } from '../ruleIds.js';

/** Поля этих типов — не поля ввода, а кнопки и служебные значения; подпись им не нужна. */
const FIELD_TYPES_WITHOUT_LABEL = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

const hasName = (el: ElementSnapshot): boolean => Boolean(el.accessibleName?.trim());

/**
 * Управляющий элемент, у которого нечего произнести.
 *
 * Обычно это кнопка с единственной иконкой: крестик закрытия, гамбургер, стрелка. Глазами всё
 * понятно, на слух — «кнопка», и человек остаётся гадать. Лечится атрибутом `aria-label`.
 */
const ruleControlWithoutName: Rule = doc => doc.elements
	.filter(el => el.interactive && !el.isFormField)
	.filter(el => !hasName(el))
	.map(el => ({
		rule: RULE.controlWithoutName,
		severity: 'error' as const,
		message: 'У элемента управления нет доступного имени',
		why: 'Программа чтения с экрана произнесёт только «кнопка» — что она делает, останется неизвестным. Добавить aria-label или видимый текст.',
		selector: el.selector,
		evidence: `${el.tag}${el.classes.length ? `.${el.classes[0]}` : ''} без текста, aria-label и title`,
	}));

/**
 * Поле ввода без подписи.
 *
 * Плейсхолдер подписью не считается — и это главное, ради чего правило написано: он исчезает
 * при первом же символе, а вместе с ним и объяснение, что тут вводят. Форма, заполненная
 * наполовину, превращается в набор безымянных прямоугольников.
 */
const ruleFieldWithoutLabel: Rule = doc => doc.elements
	.filter(el => el.isFormField)
	.filter(el => !FIELD_TYPES_WITHOUT_LABEL.has(el.inputType))
	.filter(el => !hasName(el))
	.map(el => ({
		rule: RULE.fieldWithoutLabel,
		severity: 'error' as const,
		message: el.hasPlaceholder
			? 'У поля только плейсхолдер вместо подписи'
			: 'У поля нет подписи',
		why: el.hasPlaceholder
			? 'Плейсхолдер исчезает при вводе, и заполненная форма остаётся набором безымянных полей. Нужна подпись: <label for> или aria-label.'
			: 'Ни программа чтения с экрана, ни человек не узнают, что здесь вводить. Нужен <label for> или aria-label.',
		selector: el.selector,
		evidence: el.hasPlaceholder ? 'placeholder есть, подписи нет' : 'ни label, ни aria-label',
	}));

/**
 * Изображение без атрибута `alt`.
 *
 * Ловится именно ОТСУТСТВИЕ атрибута, а не пустое значение: `alt=""` — законное и осмысленное
 * «картинка декоративная, читать нечего», и требовать текст от разделителя или фонового узора
 * было бы вредно. А вот при пропущенном атрибуте программа чтения зачитает имя файла.
 */
const ruleImageWithoutAlt: Rule = doc => doc.elements
	.filter(el => el.tag === 'img')
	.filter(el => !el.hasAltAttribute)
	.map(el => ({
		rule: RULE.imageWithoutAlt,
		severity: 'error' as const,
		message: 'У изображения нет атрибута alt',
		why: 'Вместо описания будет зачитано имя файла. Если картинка декоративная — поставить alt="" явно, это законный способ сказать «читать нечего».',
		selector: el.selector,
		evidence: el.imgSrc ? el.imgSrc.slice(-60) : 'без src',
	}));

export const MARKUP_RULES: readonly Rule[] = [
	ruleControlWithoutName,
	ruleFieldWithoutLabel,
	ruleImageWithoutAlt,
];
