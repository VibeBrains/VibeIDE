/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reads a design system off a page that already exists.
 *
 * Why from a snapshot and not from the CSS: stylesheets say what was written, a snapshot says what
 * won. Cascade, media queries, framework defaults and a token that is overridden three files later
 * all collapse into the value the browser actually used — which is the value the design system has
 * to describe.
 *
 * A measurement is not a decision: the caller writes it into `design.md` as a draft for a human to
 * cut down, and the file says so.
 */

import { DocumentSnapshot, ElementSnapshot, hueSaturation, lightness, primaryFamily, rgbToHex } from '../designReview/designSnapshot.js';
import { DesignSystemDraft } from './designContextFile.js';

/** Below this share of the text on the page a family is an accident, not part of the system. */
const MIN_FAMILY_SHARE = 0.02;
/** A colour used fewer times than this is noise from one stray element. */
const MIN_COLOR_USES = 2;
/** How many steps of a type scale are worth naming; below that it is not a scale. */
const MAX_TYPE_STEPS = 6;
const MAX_RADII = 4;
const MAX_SHADOWS = 3;
/** Saturation from which a colour reads as an accent rather than as ink or paper. */
const ACCENT_MIN_SATURATION = 0.35;

type Digest = Pick<DesignSystemDraft, 'colors' | 'fonts' | 'typeScale' | 'radiiPx' | 'shadows'>;

/** Mutable working shapes; the draft's fields are readonly, so they are built up here first. */
type FontEntry = { family: string; role: string };
type ColorEntry = { hex: string; role: string };

const hasText = (el: ElementSnapshot): boolean => el.text.length > 0 && el.fontSizePx > 0;

/** Counts values and returns them most-used first; ties keep first-seen order. */
function rank<T>(values: readonly T[]): { value: T; count: number }[] {
	const counts = new Map<T, number>();
	for (const value of values) {
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) => b.count - a.count);
}

/** Names for the steps of a scale, biggest first — the vocabulary a designer would use. */
const TYPE_STEP_NAMES = ['Дисплей', 'Заголовок', 'Подзаголовок', 'Текст', 'Подпись', 'Метка'];

export function digestSnapshot(doc: DocumentSnapshot): Digest {
	const texts = doc.elements.filter(hasText);

	// --- families: the one carrying the biggest type is the display voice, the most used is body
	const families = rank(texts.map(el => primaryFamily(el.fontFamily)).filter(Boolean));
	const kept = families.filter(entry => entry.count / Math.max(1, texts.length) >= MIN_FAMILY_SHARE);
	const biggestFor = (family: string): number => Math.max(
		0,
		...texts.filter(el => primaryFamily(el.fontFamily) === family).map(el => el.fontSizePx),
	);
	const display = [...kept].sort((a, b) => biggestFor(b.value) - biggestFor(a.value))[0];
	const body = kept[0];
	const fonts: FontEntry[] = [];
	if (display) {
		fonts.push({ family: display.value, role: 'Гарнитура заголовков' });
	}
	if (body && body.value !== display?.value) {
		fonts.push({ family: body.value, role: 'Гарнитура текста' });
	}
	for (const entry of kept) {
		if (!fonts.some(font => font.family === entry.value)) {
			fonts.push({ family: entry.value, role: 'Ещё в ходу' });
		}
	}

	// --- palette: ink, paper and the accent, by how much of the page they hold
	const inkRanked = rank(texts.map(el => rgbToHex(el.color)));
	const paperRanked = rank(doc.elements.map(el => rgbToHex(el.backgroundColor)));
	const accentRanked = rank(
		doc.elements
			.filter(el => hueSaturation(el.color).saturation >= ACCENT_MIN_SATURATION && el.text.length > 0)
			.map(el => rgbToHex(el.color))
			.concat(doc.elements
				.filter(el => el.ownBackgroundAlpha > 0.5 && hueSaturation(el.backgroundColor).saturation >= ACCENT_MIN_SATURATION)
				.map(el => rgbToHex(el.backgroundColor))),
	);
	const colors: ColorEntry[] = [];
	const pushColor = (hex: string | undefined, role: string): void => {
		if (hex && !colors.some(color => color.hex === hex)) {
			colors.push({ hex, role });
		}
	};
	pushColor(paperRanked[0]?.value, 'Фон');
	pushColor(inkRanked[0]?.value, 'Текст');
	pushColor(accentRanked[0]?.value, 'Акцент');
	for (const entry of [...inkRanked, ...paperRanked].filter(item => item.count >= MIN_COLOR_USES)) {
		pushColor(entry.value, lightness(hexToRgb(entry.value)) > 0.5 ? 'Светлый тон' : 'Тёмный тон');
	}

	// --- type scale: distinct sizes, biggest first, with the weight and leading they came with
	const bySize = new Map<number, ElementSnapshot>();
	for (const el of texts) {
		const size = Math.round(el.fontSizePx);
		const seen = bySize.get(size);
		// Keep the longest-text example of each size: it is the most representative of the step.
		if (!seen || el.text.length > seen.text.length) {
			bySize.set(size, el);
		}
	}
	const typeScale = [...bySize.entries()]
		.sort((a, b) => b[0] - a[0])
		.slice(0, MAX_TYPE_STEPS)
		.map(([size, el], index) => ({
			name: TYPE_STEP_NAMES[index] ?? `Уровень ${index + 1}`,
			sizePx: size,
			weight: el.fontWeight,
			lineHeight: el.fontSizePx > 0 ? el.lineHeightPx / el.fontSizePx : 0,
		}));

	// --- shape and depth
	const radiiPx = rank(
		doc.elements.filter(el => el.borderRadiusPx > 0).map(el => Math.round(el.borderRadiusPx)),
	).slice(0, MAX_RADII).map(entry => entry.value).sort((a, b) => a - b);

	const shadows = rank(
		doc.elements.map(el => el.boxShadow).filter(shadow => shadow && shadow !== 'none'),
	).slice(0, MAX_SHADOWS).map(entry => entry.value);

	return { colors, fonts, typeScale, radiiPx, shadows };
}

function hexToRgb(hex: string): [number, number, number] {
	const value = hex.replace('#', '');
	const full = value.length === 3 ? value.split('').map(char => char + char).join('') : value;
	return [
		parseInt(full.slice(0, 2), 16) || 0,
		parseInt(full.slice(2, 4), 16) || 0,
		parseInt(full.slice(4, 6), 16) || 0,
	];
}
