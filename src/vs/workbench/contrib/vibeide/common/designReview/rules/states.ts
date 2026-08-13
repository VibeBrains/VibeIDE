/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Состояния интерактивных элементов: фокус, запрет, наведение.
 *
 * Остальные правила смотрят на свойства пикселей — контраст, кегль, обрезание. Эти смотрят на
 * то, чего на странице НЕТ: у кнопки нет видимого фокуса, у выключенного поля нет отличия от
 * включённого. Пропущенное состояние ничем себя не выдаёт на скриншоте, поэтому его и не видно
 * ни при беглом взгляде, ни при обычном прогоне детектора.
 *
 * Слой подсказан по-компонентными чек-листами (checklist.design): у каждого интерактивного
 * компонента там повторяется один и тот же набор состояний. Формулировки и пороги наши;
 * оттуда взята мысль, что состояние — это часть компонента, а не украшение.
 *
 * Правила молчат, когда таблицы стилей прочитать не удалось: «правила фокуса не нашли» и «не
 * смогли посмотреть» — разные вещи, и вторая не повод обвинять.
 */

import { ElementSnapshot, Rule } from '../designSnapshot.js';
import { RULE } from '../ruleIds.js';

/** Ниже этой ширины обводка перестаёт читаться как индикатор фокуса. */
const MIN_FOCUS_OUTLINE_PX = 1;

/**
 * Насколько выключенный элемент обязан отличаться от обычного. Порог по разнице прозрачности
 * или яркости: точное значение не важно, важно, что отличие видно.
 */
const DISABLED_MIN_RELATIVE_DIFF = 0.12;

const isMeasurable = (el: ElementSnapshot): boolean => !el.styleRulesUnreadable;

/** Яркость по формуле восприятия — для сравнения «насколько приглушён» без цветовой теории. */
const luminance = (rgb: readonly [number, number, number]): number =>
	(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;

/**
 * Фокус, убранный и ничем не заменённый.
 *
 * Ловится именно эта комбинация, а не «нет правила :focus»: браузер рисует обводку сам, и
 * элемент без единого правила фокуса обычно в порядке. Беда начинается, когда `outline` снят —
 * почти всегда ради вида — и замены не появилось. Тогда работа с клавиатуры становится слепой:
 * человек не видит, где находится.
 */
const ruleFocusNotVisible: Rule = doc => doc.elements
	.filter(isMeasurable)
	.filter(el => el.interactive && !el.disabled)
	.filter(el => el.outlineStyle === 'none' || el.outlineWidthPx < MIN_FOCUS_OUTLINE_PX)
	.filter(el => !el.hasFocusRule)
	.map(el => ({
		rule: RULE.focusNotVisible,
		severity: 'error' as const,
		message: 'У интерактивного элемента не видно фокуса',
		why: 'Обводка снята, а замены нет: с клавиатуры не понять, где находишься. Вернуть outline или задать свой стиль для :focus-visible.',
		selector: el.selector,
		evidence: `outline: ${el.outlineStyle}${el.outlineWidthPx ? ` ${el.outlineWidthPx}px` : ''}, правил :focus не найдено`,
	}));

/**
 * Выключенный элемент, неотличимый от рабочего.
 *
 * Сравнивается с интерактивными соседями по тому же родителю — это и есть та группа, внутри
 * которой человек выбирает, на что нажать. Отличие ищется по прозрачности и по яркости текста:
 * приглушают обычно одним из двух способов.
 */
const ruleDisabledIndistinguishable: Rule = doc => {
	const enabledByParent = new Map<string, ElementSnapshot[]>();
	for (const el of doc.elements) {
		if (!el.interactive || el.disabled) {
			continue;
		}
		const siblings = enabledByParent.get(el.parentSelector) ?? [];
		siblings.push(el);
		enabledByParent.set(el.parentSelector, siblings);
	}

	return doc.elements
		.filter(isMeasurable)
		.filter(el => el.interactive && el.disabled)
		.flatMap(el => {
			const peers = enabledByParent.get(el.parentSelector) ?? [];
			if (!peers.length) {
				// Не с чем сравнивать: выключенный элемент один в группе. Судить о том, «выглядит
				// ли он выключенным», в одиночку нельзя — тут промолчать честнее.
				return [];
			}
			const peer = peers[0];
			const opacityDiff = Math.abs(el.ownBackgroundAlpha - peer.ownBackgroundAlpha);
			const textDiff = Math.abs(luminance(el.color) - luminance(peer.color));
			if (opacityDiff >= DISABLED_MIN_RELATIVE_DIFF || textDiff >= DISABLED_MIN_RELATIVE_DIFF) {
				return [];
			}
			return [{
				rule: RULE.disabledIndistinguishable,
				severity: 'error' as const,
				message: 'Выключенный элемент выглядит как рабочий',
				why: 'Нажатие ничего не даст, а причина не видна — человек решит, что интерфейс сломался. Приглушить цвет или прозрачность.',
				selector: el.selector,
				evidence: `текст rgb(${el.color.join(',')}) против rgb(${peer.color.join(',')}) у соседнего рабочего`,
			}];
		});
};

/**
 * Интерактивный элемент, который никак не отзывается на наведение.
 *
 * Это `drift`, а не пол качества: на сенсорном экране наведения нет вовсе, и проект вправе
 * решить, что оно ему не нужно. Но отсутствие отклика у всех элементов сразу — обычно не
 * решение, а недосмотр.
 */
const ruleNoHoverAffordance: Rule = doc => doc.elements
	.filter(isMeasurable)
	.filter(el => el.interactive && !el.disabled)
	.filter(el => !el.hasHoverRule)
	// Переход — признак того, что отклик задан в другом месте (например, на родителе или через
	// класс, добавляемый скриптом). Тогда правило молчит: доказать отсутствие мы не можем.
	.filter(el => el.transitionProperty === 'none' || !el.transitionProperty)
	.map(el => ({
		rule: RULE.noHoverAffordance,
		severity: 'info' as const,
		message: 'Нет отклика на наведение',
		why: 'Указатель не подсказывает, что элемент нажимается. Для сенсорного интерфейса это нормально — тогда правило можно принять как решение проекта.',
		selector: el.selector,
		evidence: 'ни правила :hover, ни transition',
	}));

export const STATE_RULES: readonly Rule[] = [
	ruleFocusNotVisible,
	ruleDisabledIndistinguishable,
	ruleNoHoverAffordance,
];
