/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Всплывающая подсказка элемента — общая vibe-tooltip, а не нативный `title`
 * Нативный `title` Chromium показывает, только когда курсор около секунды стоит неподвижно:
 * Любое движение сбрасывает отсчёт, и на маленьких значках подсказка вызывалась через раз
 * Нового нативного `title` на HTML-элементе не пропустит гейт `scripts/vibe-tooltip-gate.ts`
 */

/** Id общей подсказки — она смонтирована один раз на всё окно (`vibe-tooltip/VibeTooltip.tsx`) */
export const VIBE_TOOLTIP_ID = 'vibe-tooltip';

/**
 * Задержка подсказки у строк списков
 * Без неё описание мелькало бы у каждой строки, мимо которой мышь едет к нужной
 */
export const LIST_ROW_TOOLTIP_DELAY_MS = 300;

export type TooltipPlace = 'top' | 'right' | 'bottom' | 'left';

/**
 * Что текст подсказки значит для чтеца экрана
 * Нативный `title` давал элементу имя или описание сам, всплывающий слой чтец не видит
 */
export type TooltipAccessibility =
	/** Описание поверх видимого текста элемента — по умолчанию */
	| 'description'
	/** Имя элемента: значок без видимого текста и без своего `aria-label` */
	| 'label'
	/** Ничего: у элемента уже есть `aria-label`, или подсказка повторяет его видимый текст (обрезанная строка) */
	| 'none';

export interface ITooltipOptions {
	/** Сторона, с которой всплывает подсказка; без неё решает react-tooltip */
	readonly place?: TooltipPlace;
	/** Своя задержка показа; без неё — общая из `VibeTooltip` */
	readonly delayShowMs?: number;
	readonly accessibility?: TooltipAccessibility;
}

export interface ITooltipProps {
	readonly 'data-tooltip-id'?: string;
	readonly 'data-tooltip-content'?: string;
	readonly 'data-tooltip-place'?: TooltipPlace;
	readonly 'data-tooltip-delay-show'?: number;
	readonly 'aria-label'?: string;
	readonly 'aria-description'?: string;
}

/**
 * Атрибуты общей подсказки: `<button {...tooltipProps(text)}>`
 * Пустой текст даёт пустой набор, поэтому `title={cond ? text : undefined}` переходит в `tooltipProps(cond ? text : undefined)`
 */
export function tooltipProps(text: string | null | undefined, options?: ITooltipOptions): ITooltipProps {
	if (!text) {
		return {};
	}
	const accessibility = options?.accessibility ?? 'description';
	return {
		'data-tooltip-id': VIBE_TOOLTIP_ID,
		'data-tooltip-content': text,
		...(options?.place ? { 'data-tooltip-place': options.place } : {}),
		...(options?.delayShowMs !== undefined ? { 'data-tooltip-delay-show': options.delayShowMs } : {}),
		...(accessibility === 'label' ? { 'aria-label': text } : {}),
		...(accessibility === 'description' ? { 'aria-description': text } : {}),
	};
}
