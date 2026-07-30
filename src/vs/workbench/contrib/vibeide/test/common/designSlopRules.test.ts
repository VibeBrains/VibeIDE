/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	contrastRatio,
	DocumentSnapshot,
	ElementSnapshot,
	hueSaturation,
	mergeViewportFindings,
	reviewDesign,
	summarize,
} from '../../common/designReview/designSlopRules.js';
import { ALL_RULE_IDS, RULE_META, RuleId } from '../../common/designReview/ruleIds.js';

/** A neutral element: dark text on white, comfortable everything. Tests override one field at a time. */
const el = (over: Partial<ElementSnapshot> = {}): ElementSnapshot => ({
	selector: 'main > p',
	parentSelector: 'main',
	tag: 'p',
	text: '',
	classes: [],
	childTags: [],
	cardDepth: 0,
	fontSizePx: 16,
	lineHeightPx: 24,
	letterSpacingPx: 0,
	fontFamily: 'PT Sans, sans-serif',
	fontWeight: 400,
	fontStyle: 'normal',
	textTransform: 'none',
	textAlign: 'left',
	color: [17, 17, 17],
	backgroundColor: [255, 255, 255],
	ownBackgroundAlpha: 0,
	backgroundImage: 'none',
	backgroundClip: 'border-box',
	boxShadow: 'none',
	backdropFilter: 'none',
	borderRadiusPx: 0,
	borderWidthPx: { top: 0, right: 0, bottom: 0, left: 0 },
	borderColor: [0, 0, 0],
	borderAlpha: 0,
	animationName: 'none',
	animationTimingFunction: 'ease',
	animationDurationMs: 0,
	transitionProperty: 'none',
	transitionTimingFunction: 'ease',
	position: 'static',
	zIndex: 0,
	overflowX: 'visible',
	overflowY: 'visible',
	widthPx: 600,
	heightPx: 48,
	leftPx: 0,
	topPx: 0,
	scrollWidthPx: 600,
	clientWidthPx: 600,
	paddingPx: { top: 0, right: 0, bottom: 0, left: 0 },
	marginPx: { top: 0, right: 0, bottom: 0, left: 0 },
	imgSrc: '',
	imgNaturalWidthPx: 0,
	svgShapeCount: 0,
	textLineCount: 0,
	linesEndingWithShortWord: 0,
	lastLineWordCount: 0,
	interactive: false,
	...over,
});

const doc = (elements: ElementSnapshot[], over: Partial<DocumentSnapshot> = {}): DocumentSnapshot => ({
	url: 'https://example.com/',
	viewportWidthPx: 1280,
	viewportHeightPx: 800,
	elements,
	headings: [],
	...over,
});

const rulesFired = (snapshot: DocumentSnapshot): string[] => [...new Set(reviewDesign(snapshot).map(f => f.rule))].sort();

suite('designSlopRules', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a plain, well-set page produces no findings', () => {
		const page = doc(
			[
				el({ text: 'Обычный абзац, который читается без усилий и ничем не выделяется.'.repeat(2) }),
				el({ selector: 'h1', tag: 'h1', text: 'Заголовок', fontSizePx: 40, widthPx: 500 }),
				el({ selector: 'button', tag: 'button', text: 'Отправить', fontSizePx: 15, interactive: true, widthPx: 120, heightPx: 44 }),
			],
			{ headings: [{ tag: 'h1', text: 'Заголовок', fontSizePx: 40 }, { tag: 'h2', text: 'Раздел', fontSizePx: 28 }] },
		);
		// `single-font` is expected here: the fixture deliberately uses one family everywhere.
		assert.deepStrictEqual(rulesFired(page), ['single-font']);
	});

	test('typography floors: tiny text, small button label, tight leading', () => {
		const page = doc([
			el({ selector: '.fine-print', text: 'Мелкий шрифт внизу страницы', fontSizePx: 10 }),
			el({ selector: 'button', tag: 'button', text: 'Ок', fontSizePx: 11, interactive: true, widthPx: 60, heightPx: 46 }),
			el({ selector: '.dense', text: 'Абзац с плотными строками, который тянется на несколько строк подряд.', fontSizePx: 16, lineHeightPx: 18 }),
		]);
		assert.deepStrictEqual(rulesFired(page), ['single-font', 'tight-leading', 'tiny-text', 'undersized-ui-text']);
	});

	test('contrast uses the WCAG large-text exemption', () => {
		// 130 даёт ≈3.8:1 — проваливает порог для обычного текста (4.5) и проходит для крупного (3).
		const grey: [number, number, number] = [130, 130, 130];
		const page = doc([
			el({ selector: '.body', text: 'Серый мелкий текст на белом фоне, читать тяжело.', color: grey }),
			el({ selector: 'h1', tag: 'h1', text: 'Крупный заголовок', color: grey, fontSizePx: 32, widthPx: 500 }),
		]);
		const findings = reviewDesign(page).filter(f => f.rule === 'low-contrast');
		assert.deepStrictEqual(findings.map(f => f.selector), ['.body']);
	});

	test('generator tells: gradient text, violet heading, halo, glow, decorative animation', () => {
		const page = doc([
			el({ selector: 'h1 span', tag: 'span', text: 'Градиент', fontSizePx: 48, backgroundClip: 'text', backgroundImage: 'linear-gradient(120deg, rgb(252,40,168), rgb(124,92,255))', color: [124, 92, 255] }),
			el({ selector: '.hero', text: '', backgroundImage: 'radial-gradient(circle at 30% 40%, rgba(124,92,255,.3), transparent)', widthPx: 900, heightPx: 400 }),
			el({ selector: '.card', text: '', boxShadow: 'rgba(252, 40, 168, 0.35) 0px 0px 40px 10px' }),
			el({ selector: '.dot', text: '', animationName: 'pulse' }),
		]);
		assert.deepStrictEqual(rulesFired(page), ['ai-color-palette', 'dark-glow', 'decorative-animation', 'gradient-text', 'radial-halo', 'single-font']);
	});

	test('a black shadow is a shadow, not a glow', () => {
		const page = doc([el({ selector: '.card', boxShadow: 'rgba(0, 0, 0, 0.2) 0px 8px 24px' })]);
		assert.deepStrictEqual(rulesFired(page), []);
	});

	test('heading structure: flat hierarchy and a skipped level', () => {
		const page = doc([], {
			headings: [
				{ tag: 'h1', text: 'Заголовок', fontSizePx: 32 },
				{ tag: 'h2', text: 'Раздел', fontSizePx: 31 },
				{ tag: 'h4', text: 'Подпункт', fontSizePx: 20 },
			],
		});
		assert.deepStrictEqual(rulesFired(page), ['flat-type-hierarchy', 'skipped-heading']);
	});

	test('copy tells: marketing filler and em-dash density', () => {
		const page = doc([
			el({ selector: '.promo', text: 'Революционный подход, который выведет вашу работу на новый уровень.' }),
			el({ selector: '.generated', text: 'Этот текст — как и любой другой — выглядит осмысленным, но тире в нём — слишком много, и это заметно с первого взгляда — правда.' }),
		]);
		assert.deepStrictEqual(rulesFired(page), ['em-dash-overuse', 'marketing-filler', 'single-font']);
	});

	test('touch target: small but tall enough is fine, small in both axes is not', () => {
		const page = doc([
			el({ selector: '.icon-btn', tag: 'button', text: '×', fontSizePx: 16, interactive: true, widthPx: 24, heightPx: 24 }),
			el({ selector: '.link', tag: 'a', text: 'Подробнее', fontSizePx: 14, interactive: true, widthPx: 90, heightPx: 20 }),
		]);
		assert.deepStrictEqual(reviewDesign(page).filter(f => f.rule === 'cramped-target').map(f => f.selector), ['.icon-btn']);
	});

	test('output is deterministic and sorted by severity', () => {
		const page = doc([
			el({ selector: '.a', text: 'Серый текст плохо читается на белом.', color: [180, 180, 180] }),
			el({ selector: '.b', text: 'Мелкий текст', fontSizePx: 9 }),
			el({ selector: '.c', text: 'Заголовок', fontSizePx: 30, color: [140, 90, 240] }),
		]);
		const first = reviewDesign(page);
		const second = reviewDesign(page);

		assert.deepStrictEqual(
			[first.map(f => `${f.severity}:${f.rule}`), summarize(first), first.map(f => f.rule)],
			[second.map(f => `${f.severity}:${f.rule}`), summarize(second), second.map(f => f.rule)],
		);
		assert.strictEqual(first[0].severity, 'error');
	});

	test('generator tells in type: kicker, icon tile, italic serif hero, template font', () => {
		const page = doc([
			el({ selector: '.kicker', tag: 'span', text: 'RELEASE PLANNING', fontSizePx: 12, letterSpacingPx: 1.4, textTransform: 'uppercase', topPx: 100, heightPx: 16 }),
			el({ selector: 'h2', tag: 'h2', text: 'Отгрузим план к пятнице', fontSizePx: 40, topPx: 120, heightPx: 48 }),
			el({ selector: '.tile', text: '', svgShapeCount: 2, widthPx: 40, heightPx: 40, borderRadiusPx: 10, topPx: 200, parentSelector: '.card' }),
			el({ selector: '.card h3', tag: 'h3', text: 'Быстрый старт', fontSizePx: 20, topPx: 240, parentSelector: '.card' }),
			el({ selector: 'h1', tag: 'h1', text: 'Курсив', fontSizePx: 56, fontStyle: 'italic', fontFamily: 'Instrument Serif, serif', widthPx: 400 }),
		]);
		assert.deepStrictEqual(rulesFired(page), [
			'icon-tile-above-heading', 'italic-serif-hero', 'kicker-label', 'overused-font',
		]);
	});

	test('surface decoration: glass, side accent, extreme radius, invisible border', () => {
		const page = doc([
			el({ selector: '.glass', backdropFilter: 'blur(12px)' }),
			el({ selector: '.tab', borderWidthPx: { top: 1, right: 1, bottom: 1, left: 6 }, borderColor: [124, 92, 255], borderAlpha: 1, backgroundColor: [255, 255, 255] }),
			el({ selector: '.pill', borderRadiusPx: 28, widthPx: 300, heightPx: 120 }),
			el({ selector: '.framed', borderWidthPx: { top: 1, right: 1, bottom: 1, left: 1 }, borderColor: [252, 252, 252], borderAlpha: 1, backgroundColor: [255, 255, 255] }),
		]);
		assert.deepStrictEqual(rulesFired(page), ['extreme-radius', 'glassmorphism', 'invisible-border', 'side-accent-border']);
	});

	test('real defects: clipped content, sheared child, occluded text, page wider than the window', () => {
		const page = doc(
			[
				el({ selector: '.row', overflowX: 'hidden', scrollWidthPx: 640, clientWidthPx: 600 }),
				el({ selector: '.slot', parentSelector: 'main', position: 'relative', overflowX: 'hidden', overflowY: 'hidden', leftPx: 0, topPx: 0, widthPx: 200, heightPx: 40 }),
				el({ selector: '.slot > .trash', parentSelector: '.slot', position: 'absolute', leftPx: 180, topPx: 8, widthPx: 40, heightPx: 24 }),
				el({ selector: '.under', text: 'Этот текст читатель не увидит', leftPx: 0, topPx: 300, widthPx: 200, heightPx: 40, zIndex: 1 }),
				el({ selector: '.cover', position: 'absolute', ownBackgroundAlpha: 1, leftPx: 0, topPx: 300, widthPx: 220, heightPx: 60, zIndex: 5 }),
				el({ selector: '.wide', leftPx: 0, topPx: 400, widthPx: 1400, heightPx: 100 }),
			],
			{ documentScrollWidthPx: 1400 },
		);
		// `single-font` rides along: the fixture's text is all one family, which is its own finding.
		assert.deepStrictEqual(rulesFired(page), ['clipped-positioned-child', 'content-overflow', 'occluded-text', 'page-overflow', 'single-font']);
	});

	test('russian typography: a hanging preposition and a lone last word', () => {
		const page = doc([
			el({ selector: '.lead', text: 'Локальное рабочее пространство для команды агентов и их задач.', textLineCount: 3, linesEndingWithShortWord: 1, lastLineWordCount: 4 }),
			el({ selector: 'h2', tag: 'h2', text: 'Одно рабочее пространство', fontSizePx: 28, textLineCount: 2, lastLineWordCount: 1 }),
		]);
		assert.deepStrictEqual(rulesFired(page), ['hanging-preposition', 'orphan-word', 'single-font']);
	});

	test('motion: overshoot easing and animated layout properties', () => {
		const page = doc([
			el({ selector: '.card', animationName: 'slideIn', animationDurationMs: 300, animationTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }),
			el({ selector: '.panel', transitionProperty: 'height, opacity' }),
		]);
		assert.deepStrictEqual(rulesFired(page), ['elastic-easing', 'layout-property-animation']);
	});

	test('imagery: a broken image and a placeholder service', () => {
		const page = doc([
			el({ selector: 'img.hero', tag: 'img', imgSrc: '/assets/hero.png', imgNaturalWidthPx: 0 }),
			el({ selector: 'img.avatar', tag: 'img', imgSrc: 'https://via.placeholder.com/64', imgNaturalWidthPx: 64 }),
		]);
		assert.deepStrictEqual(rulesFired(page), ['broken-image', 'placeholder-image']);
	});

	test('a project can accept style drift but never the quality floor', () => {
		const page = doc([
			el({ selector: '.mono', text: 'Терминальный интерфейс целиком в одной моногарнитуре.' }),
			el({ selector: '.faded', text: 'Серый текст, который не дотягивает до нормы контраста.', color: [180, 180, 180] }),
		]);
		const context = {
			design: {
				fonts: ['JetBrains Mono'],
				colors: [],
				namedRules: [],
				acceptedDrift: [
					{ rule: 'single-font', reason: 'одна моногарнитура — идентичность продукта' },
					{ rule: 'low-contrast', reason: 'попытка отключить пол качества' },
				],
				raw: '',
			},
		};
		const findings = reviewDesign(page, context);
		const summary = summarize(findings);
		assert.deepStrictEqual(
			[
				findings.filter(f => f.accepted).map(f => f.rule),
				findings.find(f => f.rule === 'low-contrast')?.accepted,
				[summary.error, summary.accepted, summary.total],
			],
			[['single-font'], undefined, [1, 1, 1]],
		);
	});

	test('every finding id is in the catalogue, with the catalogue class', () => {
		// The rules take their ids from `ruleIds.ts` and the facade stamps the class from it, so a
		// rule whose id drifted out of the catalogue would be silently treated as a floor.
		const page = doc(
			[
				el({ selector: '.a', text: 'Серый текст на белом почти не читается вовсе.', color: [190, 190, 190], fontSizePx: 9 }),
				el({ selector: '.b', text: 'ТЕКСТ ЦЕЛИКОМ ПРОПИСНЫМИ БУКВАМИ, ДЛИННЫЙ И НЕЧИТАЕМЫЙ СОВСЕМ', textTransform: 'uppercase' }),
				el({ selector: 'img', tag: 'img', imgSrc: '', imgNaturalWidthPx: 0 }),
			],
			{ headings: [{ tag: 'h1', text: 'А', fontSizePx: 30 }, { tag: 'h3', text: 'Б', fontSizePx: 29 }] },
		);
		const findings = reviewDesign(page);
		const stray = findings.filter(f => !(ALL_RULE_IDS as readonly string[]).includes(f.rule));
		const mismatched = findings.filter(f => RULE_META[f.rule as RuleId]?.ruleClass !== f.ruleClass);
		assert.deepStrictEqual([stray.map(f => f.rule), mismatched.map(f => f.rule), findings.length > 5], [[], [], true]);
	});

	test('two viewport passes merge: shared findings once, phone-only findings labelled', () => {
		const narrow = el({ selector: '.row', overflowX: 'hidden', scrollWidthPx: 420, clientWidthPx: 390 });
		const desktop = reviewDesign(doc([el({ selector: '.faded', text: 'Серый текст, который не дотягивает до нормы.', color: [190, 190, 190] })], { viewport: 'desktop' }));
		const mobile = reviewDesign(doc(
			[
				el({ selector: '.faded', text: 'Серый текст, который не дотягивает до нормы.', color: [190, 190, 190] }),
				narrow,
			],
			{ viewport: 'mobile', viewportWidthPx: 390 },
		));
		const merged = mergeViewportFindings([desktop, mobile]);
		assert.deepStrictEqual(
			merged.map(f => `${f.rule}:${f.viewport ?? 'оба'}`),
			['content-overflow:mobile', 'low-contrast:оба', 'single-font:оба'],
		);
	});

	test('colour helpers agree with known WCAG values', () => {
		assert.deepStrictEqual(
			[
				Math.round(contrastRatio([0, 0, 0], [255, 255, 255]) * 100) / 100,
				Math.round(contrastRatio([255, 255, 255], [255, 255, 255]) * 100) / 100,
				Math.round(hueSaturation([124, 92, 255]).hue),
			],
			[21, 1, 252],
		);
	});
});
