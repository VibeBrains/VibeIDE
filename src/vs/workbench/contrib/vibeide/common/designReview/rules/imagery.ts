/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Image rules: whether the picture actually arrived, and whether it was ever meant to. */

import { Rule } from '../designSnapshot.js';
import { RULE } from '../ruleIds.js';

/** Hosts and words that mean "we will put the real one here later". */
const PLACEHOLDER_SOURCE = /placehold|placeimg|dummyimage|lorempixel|picsum\.photos|example\.com|via\.placeholder|your-image|image-url|path\/to/i;

const ruleBrokenImage: Rule = doc => doc.elements
	.filter(el => el.tag === 'img')
	.filter(el => !el.imgSrc || el.imgNaturalWidthPx === 0)
	.map(el => ({
		rule: RULE.brokenImage,
		severity: 'error' as const,
		message: el.imgSrc ? 'Картинка не загрузилась' : 'У картинки нет источника',
		why: 'На месте изображения читатель видит пустоту или значок ошибки — это заметнее любого стилевого промаха.',
		selector: el.selector,
		evidence: el.imgSrc ? `src ${el.imgSrc.slice(0, 80)}, natural-width 0` : 'src пустой',
	}));

const rulePlaceholderImage: Rule = doc => doc.elements
	.filter(el => el.tag === 'img' && PLACEHOLDER_SOURCE.test(el.imgSrc))
	.map(el => ({
		rule: RULE.placeholderImage,
		severity: 'warning' as const,
		message: 'Картинка-заглушка из внешнего сервиса',
		why: 'Заглушка доезжает до продакшена чаще, чем кажется, и превращает страницу в макет.',
		selector: el.selector,
		evidence: el.imgSrc.slice(0, 80),
	}));

export const IMAGERY_RULES: readonly Rule[] = [
	ruleBrokenImage,
	rulePlaceholderImage,
];
