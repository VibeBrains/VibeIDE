/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { reviewDesign } from '../../common/designReview/designSlopRules.js';
import { RULE, RULE_META } from '../../common/designReview/ruleIds.js';
import type { DocumentSnapshot, SeoSnapshot } from '../../common/designReview/designSnapshot.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/** Безупречная по находимости страница — от неё отсчитываются все отклонения. */
const cleanSeo = (over: Partial<SeoSnapshot> = {}): SeoSnapshot => ({
	title: 'Пиццерия «Тесто» — доставка за 30 минут по Казани',
	metaDescription: 'Готовим на дровяной печи и привозим горячей: тридцать минут по городу, оплата картой при получении.',
	htmlLang: 'ru',
	canonical: 'https://example.com/pizza',
	robots: 'index, follow',
	hasViewportMeta: true,
	ogTitle: 'Пиццерия «Тесто»',
	ogDescription: 'Доставка за 30 минут',
	ogImage: 'https://example.com/og.png',
	jsonLdCount: 1,
	jsonLdBroken: 0,
	jsonLdTypes: ['Restaurant'],
	imagesWithoutAlt: 0,
	imagesTotal: 4,
	...over,
});

const page = (over: Partial<SeoSnapshot> = {}, headings = [{ tag: 'h1', text: 'Пицца', fontSizePx: 40 }]): DocumentSnapshot => ({
	url: 'https://example.com/pizza',
	viewportWidthPx: 1280,
	viewportHeightPx: 800,
	elements: [],
	headings,
	seo: cleanSeo(over),
});

const rulesFired = (doc: DocumentSnapshot): string[] =>
	reviewDesign(doc).map(finding => finding.rule).filter(rule => rule.startsWith('seo-'));

suite('designReview — находимость (SEO)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('безупречная страница не даёт ни одной находки', () => {
		assert.deepStrictEqual(rulesFired(page()), []);
	});

	test('снимок без SEO-части молчит: «не измеряли» ≠ «пусто»', () => {
		const noSeo: DocumentSnapshot = { ...page(), seo: undefined };
		// Единственное, что остаётся, — счёт <h1>: он считается по заголовкам, а не по <head>.
		assert.deepStrictEqual(rulesFired(noSeo), []);
	});

	suite('пол — то, что объективно ломает находимость', () => {
		test('нет заголовка', () => {
			assert.ok(rulesFired(page({ title: '   ' })).includes(RULE.seoMissingTitle));
		});

		test('noindex — страницы просто нет в поиске', () => {
			assert.ok(rulesFired(page({ robots: 'noindex, nofollow' })).includes(RULE.seoNoindex));
		});

		test('относительный canonical', () => {
			assert.ok(rulesFired(page({ canonical: '/pizza' })).includes(RULE.seoRelativeCanonical));
		});

		test('нет lang и нет viewport', () => {
			const fired = rulesFired(page({ htmlLang: '', hasViewportMeta: false }));
			assert.deepStrictEqual(
				[fired.includes(RULE.seoMissingLang), fired.includes(RULE.seoMissingViewport)],
				[true, true]);
		});

		test('битый JSON-LD ловится, целый — нет', () => {
			assert.deepStrictEqual(
				[
					rulesFired(page({ jsonLdCount: 2, jsonLdBroken: 1 })).includes(RULE.seoBrokenJsonLd),
					rulesFired(page({ jsonLdCount: 2, jsonLdBroken: 0 })).includes(RULE.seoBrokenJsonLd),
				],
				[true, false]);
		});

		test('картинки без атрибута alt', () => {
			assert.ok(rulesFired(page({ imagesWithoutAlt: 3 })).includes(RULE.seoImageWithoutAlt));
		});

		test('ноль и два <h1> — находка, ровно один — нет', () => {
			assert.deepStrictEqual(
				[
					rulesFired(page({}, [])).includes(RULE.seoH1Count),
					rulesFired(page({}, [{ tag: 'h1', text: 'А', fontSizePx: 40 }, { tag: 'h1', text: 'Б', fontSizePx: 38 }])).includes(RULE.seoH1Count),
					rulesFired(page()).includes(RULE.seoH1Count),
				],
				[true, true, false]);
		});
	});

	suite('дрейф — рекомендации, которые проект может переопределить', () => {
		test('короткий и длинный заголовок', () => {
			assert.deepStrictEqual(
				[
					rulesFired(page({ title: 'Пицца' })).includes(RULE.seoTitleLength),
					rulesFired(page({ title: 'П'.repeat(120) })).includes(RULE.seoTitleLength),
				],
				[true, true]);
		});

		test('отсутствие описания и открытого графа', () => {
			const fired = rulesFired(page({ metaDescription: '', ogTitle: '', ogImage: '' }));
			assert.deepStrictEqual(
				[fired.includes(RULE.seoMissingDescription), fired.includes(RULE.seoMissingOpenGraph)],
				[true, true]);
		});

		test('открытый граф сообщает, ЧЕГО именно не хватает', () => {
			const finding = reviewDesign(page({ ogImage: '' })).find(f => f.rule === RULE.seoMissingOpenGraph);
			assert.ok(finding?.message.includes('og:image'), finding?.message);
		});
	});

	test('классы правил расставлены: длины — дрейф, поломки — пол', () => {
		assert.deepStrictEqual(
			[
				RULE_META[RULE.seoTitleLength].ruleClass,
				RULE_META[RULE.seoDescriptionLength].ruleClass,
				RULE_META[RULE.seoMissingTitle].ruleClass,
				RULE_META[RULE.seoNoindex].ruleClass,
				RULE_META[RULE.seoImageWithoutAlt].ruleClass,
			],
			['drift', 'drift', 'floor', 'floor', 'floor']);
	});

	test('каждая находка объясняет причину и предъявляет доказательство', () => {
		const findings = reviewDesign(page({ title: '', metaDescription: '', canonical: '/x', robots: 'noindex', htmlLang: '', hasViewportMeta: false, jsonLdBroken: 1, imagesWithoutAlt: 2 }));
		const seoFindings = findings.filter(f => f.rule.startsWith('seo-'));
		assert.deepStrictEqual(
			[seoFindings.length > 5, seoFindings.every(f => f.why.length > 0 && f.evidence.length > 0)],
			[true, true]);
	});
});
