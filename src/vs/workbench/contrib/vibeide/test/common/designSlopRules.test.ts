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
	reviewDesign,
	summarize,
} from '../../common/designReview/designSlopRules.js';

/** A neutral element: dark text on white, comfortable everything. Tests override one field at a time. */
const el = (over: Partial<ElementSnapshot> = {}): ElementSnapshot => ({
	selector: 'main > p',
	tag: 'p',
	text: '',
	classes: [],
	cardDepth: 0,
	fontSizePx: 16,
	lineHeightPx: 24,
	letterSpacingPx: 0,
	fontFamily: 'Inter, sans-serif',
	fontWeight: 400,
	textTransform: 'none',
	textAlign: 'left',
	color: [17, 17, 17],
	backgroundColor: [255, 255, 255],
	backgroundImage: 'none',
	backgroundClip: 'border-box',
	boxShadow: 'none',
	animationName: 'none',
	widthPx: 600,
	heightPx: 48,
	paddingPx: { top: 0, right: 0, bottom: 0, left: 0 },
	interactive: false,
	...over,
});

const doc = (elements: ElementSnapshot[], over: Partial<DocumentSnapshot> = {}): DocumentSnapshot => ({
	url: 'https://example.com/',
	viewportWidthPx: 1280,
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
