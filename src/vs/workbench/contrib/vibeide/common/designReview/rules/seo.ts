/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Находимость: то, что решает, найдут страницу или нет.
 *
 * Отличие от остальных категорий — как у разметки: этих дефектов **не видно на скриншоте**.
 * Страница может быть безупречной на вид и при этом уходить в мир без заголовка, с `noindex`,
 * оставшимся от отладки, или с ссылкой, которая в мессенджере разворачивается пустым прямоугольником.
 * Ни глазами, ни в превью этого не заметить — только измерением `<head>`.
 *
 * **Что здесь пол, а что дрейф.** Полом объявлено только то, что объективно ломает находимость:
 * нет заголовка, нет или два `<h1>`, `noindex` на странице, битый JSON-LD, картинка без `alt`.
 * Длины заголовка и описания — дрейф: это рекомендация поисковика, она меняется и зависит от
 * языка (кириллица в выдаче обрезается раньше латиницы), поэтому проект вправе объявить свою
 * норму. Выдавать рекомендацию за физический факт значило бы спорить с автором о вкусе голосом
 * измерителя.
 *
 * Категория подсказана разбором `AgriciDaniel/claude-seo` (MIT), но кода оттуда нет: он на Python
 * и построен вокруг внешних платных API. Взяты проверки, которые можно посчитать на самой
 * странице, без чужой подписки и без похода в сеть.
 */

import { DocumentSnapshot, Rule, RuleFinding } from '../designSnapshot.js';
import { RULE } from '../ruleIds.js';

/** Ниже — заголовок теряется в выдаче, выше — обрезается. Рекомендация, поэтому дрейф. */
const TITLE_MIN = 30;
const TITLE_MAX = 60;
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 160;

/** Правило без снимка SEO молчит: «не измеряли» — не то же самое, что «пусто». */
const seoRule = (fn: (seo: NonNullable<DocumentSnapshot['seo']>, doc: DocumentSnapshot) => RuleFinding[]): Rule =>
	doc => (doc.seo ? fn(doc.seo, doc) : []);

/** Заголовок страницы — единственная строка, которую поисковик покажет как ссылку. */
const ruleMissingTitle: Rule = seoRule(seo => seo.title.trim() ? [] : [{
	rule: RULE.seoMissingTitle,
	severity: 'error',
	message: 'У страницы нет заголовка `<title>` — в выдаче и во вкладке браузера ей нечем назваться',
	why: 'Заголовок — единственная строка, которую поисковик показывает как саму ссылку. Без него он подставит что придётся: имя домена или первую строку текста.',
	selector: 'head',
	evidence: '<title> отсутствует или пуст',
}]);

const ruleTitleLength: Rule = seoRule(seo => {
	const length = seo.title.trim().length;
	if (!length || (length >= TITLE_MIN && length <= TITLE_MAX)) { return []; }
	return [{
		rule: RULE.seoTitleLength,
		severity: 'info',
		message: length < TITLE_MIN
			? `Заголовок короткий: ${length} символов — по нему трудно понять, о чём страница`
			: `Заголовок длинный: ${length} символов — в выдаче он будет обрезан`,
		why: `Норма — примерно ${TITLE_MIN}–${TITLE_MAX} символов. Это рекомендация выдачи, а не закон: в кириллице обрезка наступает раньше, поэтому проект вправе объявить свою норму.`,
		selector: 'head > title',
		evidence: `${length} символов: «${seo.title.trim().slice(0, 70)}»`,
	}];
});

const ruleMissingDescription: Rule = seoRule(seo => seo.metaDescription.trim() ? [] : [{
	rule: RULE.seoMissingDescription,
	severity: 'warning',
	message: 'Нет `meta name="description"` — поисковик соберёт подпись из случайного куска текста',
	why: 'Описание — вторая строка в выдаче, та, по которой решают, стоит ли переходить. Без него туда попадёт первый попавшийся абзац, часто из меню.',
	selector: 'head',
	evidence: 'meta[name=description] отсутствует',
}]);

const ruleDescriptionLength: Rule = seoRule(seo => {
	const length = seo.metaDescription.trim().length;
	if (!length || (length >= DESCRIPTION_MIN && length <= DESCRIPTION_MAX)) { return []; }
	return [{
		rule: RULE.seoDescriptionLength,
		severity: 'info',
		message: length < DESCRIPTION_MIN
			? `Описание короткое: ${length} символов`
			: `Описание длинное: ${length} символов — хвост будет обрезан`,
		why: `Норма — примерно ${DESCRIPTION_MIN}–${DESCRIPTION_MAX} символов. Рекомендация выдачи, поэтому проект может задать свою.`,
		selector: 'head',
		evidence: `${length} символов`,
	}];
});

/**
 * Ровно один `<h1>`.
 *
 * Ноль — у страницы нет главной мысли, которую можно прочитать программой. Два и больше — их
 * две, и какая настоящая, не знает никто, включая читателя с экранным диктором.
 */
const ruleH1Count: Rule = seoRule((_seo, doc) => {
	// Считается по заголовкам, но только когда SEO измеряли: снимок, снятый ради проверки
	// вёрстки, про `<h1>` ничего не утверждает, и объявлять его отсутствие находкой значило бы
	// путать «не смотрели» с «нет».
	const count = doc.headings.filter(heading => heading.tag.toLowerCase() === 'h1').length;
	if (count === 1) { return []; }
	return [{
		rule: RULE.seoH1Count,
		severity: 'error',
		message: count === 0
			? 'На странице нет `<h1>` — главный заголовок не объявлен'
			: `На странице ${count} заголовков \`<h1>\` — главный должен быть один`,
		why: 'Главный заголовок объявляет, о чём страница. Когда его нет, это неизвестно; когда их два, неизвестно, какой настоящий — включая читателя с экранным диктором.',
		selector: 'body',
		evidence: `<h1> на странице: ${count}`,
	}];
});

/** `noindex`, забытый после отладки, — самый дорогой из тихих дефектов: страницы просто нет. */
const ruleNoindex: Rule = seoRule(seo => seo.robots.includes('noindex') ? [{
	rule: RULE.seoNoindex,
	severity: 'error',
	message: 'Страница закрыта от индексации (`robots: noindex`) — если это не задумано, её никто не найдёт',
	why: 'Самый дорогой из тихих дефектов: страница работает, выглядит правильно и при этом отсутствует в поиске. Обычно это `noindex`, оставшийся от отладки.',
	selector: 'head',
	evidence: `meta robots: ${seo.robots}`,
}] : []);

/** Канонический адрес: без него дубли страницы конкурируют друг с другом. */
const ruleCanonical: Rule = seoRule(seo => {
	const canonical = seo.canonical.trim();
	if (!canonical) {
		return [{
			rule: RULE.seoMissingCanonical,
			severity: 'warning',
			message: 'Нет `<link rel="canonical">` — адреса-двойники страницы будут считаться разными',
			why: 'Один и тот же материал доступен по нескольким адресам (со слэшем и без, с параметрами, www и без). Без канонического они конкурируют друг с другом в выдаче.',
			selector: 'head',
			evidence: 'link[rel=canonical] отсутствует',
		}];
	}
	// Относительный canonical читается по-разному разными сборщиками выдачи, поэтому спека
	// требует абсолютный. Это проверяемый факт формата, а не вкус — значит пол.
	return /^https?:\/\//i.test(canonical) ? [] : [{
		rule: RULE.seoRelativeCanonical,
		severity: 'error',
		message: `Канонический адрес относительный (\`${canonical}\`) — нужен полный, со схемой и доменом`,
		why: 'Относительный canonical разные сборщики выдачи достраивают по-разному, поэтому спецификация требует абсолютный. Это факт формата, а не предпочтение.',
		selector: 'head > link[rel=canonical]',
		evidence: `canonical: ${canonical}`,
	}];
});

const ruleHtmlLang: Rule = seoRule(seo => seo.htmlLang.trim() ? [] : [{
	rule: RULE.seoMissingLang,
	severity: 'error',
	message: 'У `<html>` нет атрибута `lang` — язык страницы неизвестен ни поиску, ни экранному диктору',
	why: 'Без языка синтезатор речи читает русский текст английскими правилами, а поиск хуже сопоставляет страницу с запросом.',
	selector: 'html',
	evidence: '<html> без атрибута lang',
}]);

const ruleViewportMeta: Rule = seoRule(seo => seo.hasViewportMeta ? [] : [{
	rule: RULE.seoMissingViewport,
	severity: 'error',
	message: 'Нет `meta name="viewport"` — на телефоне страница отрисуется как настольная и уедет за экран',
	why: 'Мобильная версия — то, что индексируется в первую очередь. Без этого тега телефон рисует страницу шириной с монитор и уменьшает её целиком.',
	selector: 'head',
	evidence: 'meta[name=viewport] отсутствует',
}]);

/**
 * Открытый граф: как ссылка выглядит, когда её отправляют человеку.
 *
 * Одно правило на три тега, а не три правила: отсутствуют они обычно вместе, и три отдельные
 * находки об одном и том же превращают список в шум.
 */
const ruleOpenGraph: Rule = seoRule(seo => {
	const missing = [
		seo.ogTitle.trim() ? '' : 'og:title',
		seo.ogDescription.trim() ? '' : 'og:description',
		seo.ogImage.trim() ? '' : 'og:image',
	].filter(Boolean);
	if (missing.length === 0) { return []; }
	return [{
		rule: RULE.seoMissingOpenGraph,
		severity: 'warning',
		message: `Не заполнено для ссылок в мессенджерах: ${missing.join(', ')} — превью будет пустым`,
		why: 'Открытый граф решает, как ссылка выглядит, когда её отправляют человеку. Без него в чате появится голый адрес вместо карточки.',
		selector: 'head',
		evidence: `отсутствуют: ${missing.join(', ')}`,
	}];
});

/**
 * Разметка данных.
 *
 * Битый JSON — пол: он не читается вообще, то есть блок бесполезен целиком, и это чистая ошибка
 * синтаксиса, а не мнение. Полное отсутствие разметки — не находка: она нужна не всякой странице.
 */
const ruleJsonLd: Rule = seoRule(seo => seo.jsonLdBroken > 0 ? [{
	rule: RULE.seoBrokenJsonLd,
	severity: 'error',
	message: `Блоков JSON-LD с синтаксической ошибкой: ${seo.jsonLdBroken} — такая разметка не читается совсем`,
	why: 'Разметка данных либо разбирается целиком, либо не работает вовсе. Битый блок — не половина пользы, а ноль, причём молчаливый.',
	selector: 'head',
	evidence: `битых блоков: ${seo.jsonLdBroken} из ${seo.jsonLdCount}`,
}] : []);

/**
 * Картинки без `alt`.
 *
 * Именно БЕЗ атрибута: пустой `alt=""` — законное «картинка декоративная», и путать эти два
 * случая значит требовать подпись у разделительной линии.
 */
const ruleImagesWithoutAlt: Rule = seoRule(seo => seo.imagesWithoutAlt > 0 ? [{
	rule: RULE.seoImageWithoutAlt,
	severity: 'error',
	message: `Картинок без атрибута \`alt\`: ${seo.imagesWithoutAlt} из ${seo.imagesTotal} — они не попадут в поиск и не будут описаны вслух`,
	why: 'Пустой alt="" — законное «картинка декоративная». Отсутствие атрибута означает, что о картинке не подумали: она молчит и для поиска, и для экранного диктора.',
	selector: 'img',
	evidence: `без alt: ${seo.imagesWithoutAlt} из ${seo.imagesTotal}`,
}] : []);

export const SEO_RULES: readonly Rule[] = [
	ruleMissingTitle,
	ruleTitleLength,
	ruleMissingDescription,
	ruleDescriptionLength,
	ruleH1Count,
	ruleNoindex,
	ruleCanonical,
	ruleHtmlLang,
	ruleViewportMeta,
	ruleOpenGraph,
	ruleJsonLd,
	ruleImagesWithoutAlt,
];
