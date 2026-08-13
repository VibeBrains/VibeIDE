/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	acceptedDriftFor,
	hasUsableContext,
	parseComponentNotes,
	parseDesignSystem,
	parseProductContext,
	renderDesignSystem,
	renderProductContext,
	unknownAcceptedDrift,
} from '../../common/designContext/designContextFile.js';
import { digestSnapshot } from '../../common/designContext/summariseSnapshot.js';
import { DocumentSnapshot, ElementSnapshot } from '../../common/designReview/designSnapshot.js';
import { ALL_RULE_IDS } from '../../common/designReview/ruleIds.js';

const PRODUCT_RU = `# Продукт: Eggent

## Для кого

Основатель-одиночка, который проверяет новый инструмент с телефона между встречами.

## Позиционирование

Разворачивается на своём сервере за полминуты — соседние продукты просят карту и облако.

## Платформа

web
`;

/** Written by another design skill: English headings, same meaning. */
const PRODUCT_EN = `# Product: Eggent

## Audience
Solo founders evaluating a new tool on their phone between meetings.

## Positioning
Runs on your own server in thirty seconds.

## Platform
adaptive
`;

const DESIGN_MD = `# Дизайн-система: Eggent

## Цвета

- Фон: \`#0B0B0F\`
- Акцент: \`#FFD34E\`
- Ошибка: \`#C2185B\`

### Именованные правила

**Правило переиспользования семантики.** Предупреждение — жёлтый бренда, ошибка — багровый;
новых оттенков состояния не вводим.

## Типографика

**Гарнитура заголовков:** \`Press Start 2P\` (fallback \`VT323\`)
**Гарнитура текста:** \`JetBrains Mono\`

### Именованные правила

**Правило пиксельных моментов.** Пиксельный шрифт живёт только в брендовых моментах: логотип,
герой, кикеры разделов. Коснулся абзаца — правило сломано.

## Детектор

- single-font — весь продукт намеренно в моногарнитуре
- dark-glow — свечение это идентичность пиксель-мира
- gradiant-text — опечатка, такого правила нет
`;

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
	fontFamily: 'JetBrains Mono, monospace',
	fontWeight: 400,
	fontStyle: 'normal',
	textTransform: 'none',
	textAlign: 'left',
	color: [230, 230, 230],
	backgroundColor: [11, 11, 15],
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
	outlineStyle: 'auto',
	outlineWidthPx: 2,
	hasFocusRule: true,
	hasHoverRule: true,
	disabled: false,
	styleRulesUnreadable: false,
	accessibleName: 'элемент',
	isFormField: false,
	inputType: '',
	hasPlaceholder: false,
	hasAltAttribute: true,
	ariaInvalid: false,
	describedByText: '',
	isRequiredField: false,
	...over,
});

suite('designContextFile', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('product context reads the Russian file we write', () => {
		const product = parseProductContext(PRODUCT_RU);
		assert.deepStrictEqual(
			[product?.audience, product?.positioning, product?.platform],
			[
				'Основатель-одиночка, который проверяет новый инструмент с телефона между встречами.',
				'Разворачивается на своём сервере за полминуты — соседние продукты просят карту и облако.',
				'web',
			],
		);
	});

	test('product context also reads an English PRODUCT.md from another tool', () => {
		const product = parseProductContext(PRODUCT_EN);
		assert.deepStrictEqual(
			[product?.audience, product?.platform],
			['Solo founders evaluating a new tool on their phone between meetings.', 'adaptive'],
		);
	});

	test('an empty or absent file is silence, not an empty system', () => {
		assert.deepStrictEqual(
			[parseProductContext(undefined), parseProductContext('   '), parseDesignSystem(null)],
			[undefined, undefined, undefined],
		);
	});

	test('design system collects palette, families and rules from every matching section', () => {
		const design = parseDesignSystem(DESIGN_MD);
		assert.deepStrictEqual(
			[design?.colors, design?.fonts, design?.namedRules.map(rule => rule.name)],
			[
				['#0b0b0f', '#ffd34e', '#c2185b'],
				['Press Start 2P', 'VT323', 'JetBrains Mono'],
				['Правило переиспользования семантики', 'Правило пиксельных моментов'],
			],
		);
	});

	test('accepted drift carries its reason, and a typo is reported instead of silently doing nothing', () => {
		const context = { design: parseDesignSystem(DESIGN_MD) };
		assert.deepStrictEqual(
			[
				acceptedDriftFor(context, 'single-font')?.reason,
				acceptedDriftFor(context, 'low-contrast'),
				unknownAcceptedDrift(context, ALL_RULE_IDS),
			],
			['весь продукт намеренно в моногарнитуре', undefined, ['gradiant-text']],
		);
	});

	test('usable context needs something to lean on', () => {
		assert.deepStrictEqual(
			[
				hasUsableContext(undefined),
				hasUsableContext({}),
				hasUsableContext({ design: parseDesignSystem(DESIGN_MD) }),
			],
			[false, false, true],
		);
	});

	test('what we write, we can read back', () => {
		const product = parseProductContext(renderProductContext({
			name: 'VibeIDE',
			audience: 'Разработчик, который правит интерфейс вечером после работы.',
			positioning: 'Правки видно сразу в превью, без второго окна.',
			platform: 'web',
		}));
		const design = parseDesignSystem(renderDesignSystem({
			name: 'VibeIDE',
			colors: [{ hex: '#0b0b0f', role: 'Фон' }],
			fonts: [{ family: 'JetBrains Mono', role: 'Гарнитура текста' }],
			typeScale: [{ name: 'Текст', sizePx: 16, weight: 400, lineHeight: 1.5 }],
			radiiPx: [12],
			shadows: ['rgba(0, 0, 0, 0.2) 0px 8px 24px'],
			namedRules: [{ name: 'Правило одного акцента', body: 'На экране один акцент, остальное — тон.' }],
			acceptedDrift: [{ rule: 'single-font', reason: 'моногарнитура — это выбор' }],
		}));
		assert.deepStrictEqual(
			[
				product?.audience,
				product?.platform,
				design?.colors,
				design?.fonts,
				design?.namedRules.map(rule => rule.name),
				design?.acceptedDrift,
			],
			[
				'Разработчик, который правит интерфейс вечером после работы.',
				'web',
				['#0b0b0f'],
				['JetBrains Mono'],
				['Правило одного акцента'],
				[{ rule: 'single-font', reason: 'моногарнитура — это выбор' }],
			],
		);
	});
});

suite('designContextFile — памятки по компонентам', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const COMPONENTS_MD = [
		'# Памятки по компонентам',
		'',
		'Вступление, которое разделом не является по смыслу, но телом заголовка является.',
		'',
		'## Форма',
		'',
		'- Кнопка блокируется на время отправки.',
		'',
		'## Таблица',
		'',
		'- Числа выровнены по правому краю.',
		'',
		'## Заготовка',
		'',
	].join('\n');

	test('заголовки становятся памятками, пустой раздел не считается', () => {
		const parsed = parseComponentNotes(COMPONENTS_MD);
		assert.deepStrictEqual(parsed?.notes.map(note => note.name), ['Памятки по компонентам', 'Форма', 'Таблица']);
	});

	test('тело памятки достаётся целиком и сырой текст сохраняется', () => {
		const parsed = parseComponentNotes(COMPONENTS_MD);
		assert.deepStrictEqual(
			[parsed?.notes.find(note => note.name === 'Форма')?.body, parsed?.raw === COMPONENTS_MD],
			['- Кнопка блокируется на время отправки.', true]);
	});

	test('пустой или отсутствующий файл — молчание, а не пустая структура', () => {
		assert.deepStrictEqual(
			[parseComponentNotes(undefined), parseComponentNotes(null), parseComponentNotes('   ')],
			[undefined, undefined, undefined]);
	});
});

suite('summariseSnapshot', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the system off what the page computed, not off what the CSS said', () => {
		const page: DocumentSnapshot = {
			url: 'http://localhost:3000/',
			viewportWidthPx: 1280,
			viewportHeightPx: 800,
			headings: [],
			elements: [
				el({ selector: 'h1', tag: 'h1', text: 'ЗАГОЛОВОК', fontFamily: 'Press Start 2P, monospace', fontSizePx: 48, fontWeight: 400, lineHeightPx: 55 }),
				el({ selector: 'p', text: 'Основной текст страницы, набранный моногарнитурой.', fontSizePx: 16 }),
				el({ selector: 'p.small', text: 'Подпись под блоком.', fontSizePx: 13 }),
				el({ selector: '.cta', tag: 'button', text: 'Развернуть', color: [11, 11, 15], backgroundColor: [255, 211, 78], ownBackgroundAlpha: 1, borderRadiusPx: 4, interactive: true, boxShadow: 'rgb(194, 24, 91) 2px 2px 0px' }),
				el({ selector: '.card', borderRadiusPx: 12, boxShadow: 'rgb(194, 24, 91) 2px 2px 0px' }),
			],
		};
		const digest = digestSnapshot(page);
		assert.deepStrictEqual(
			[
				digest.fonts,
				digest.colors.slice(0, 3),
				digest.typeScale.map(step => `${step.name}:${step.sizePx}`),
				digest.radiiPx,
				digest.shadows,
			],
			[
				[
					{ family: 'press start 2p', role: 'Гарнитура заголовков' },
					{ family: 'jetbrains mono', role: 'Гарнитура текста' },
				],
				[
					{ hex: '#0b0b0f', role: 'Фон' },
					{ hex: '#e6e6e6', role: 'Текст' },
					{ hex: '#ffd34e', role: 'Акцент' },
				],
				['Дисплей:48', 'Заголовок:16', 'Подзаголовок:13'],
				[4, 12],
				['rgb(194, 24, 91) 2px 2px 0px'],
			],
		);
	});
});
