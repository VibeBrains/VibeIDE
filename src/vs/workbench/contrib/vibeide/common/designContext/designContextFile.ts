/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The project's design context: two markdown files, parsed into what a generator actually needs.
 *
 * Why two and not one: `product.md` answers "for whom and what for" and changes when the product
 * changes; `design.md` answers "in which visual world" and changes when the look changes. A model
 * asked to build a screen without the first produces something generic, and without the second
 * produces something that does not belong to this product.
 *
 * The files are the user's, not ours — they are plain markdown, hand-editable, and a missing
 * section is silence rather than an error. Section titles are matched against a list of aliases so
 * a `DESIGN.md`/`PRODUCT.md` pair written by another tool still reads.
 *
 * Pure: no file system here, so the parser is testable from `test/common/`.
 */

/** Which surface the design targets; decided from the code, asked only when ambiguous. */
export type DesignPlatform = 'web' | 'ios' | 'android' | 'adaptive';

export const DESIGN_PLATFORMS: readonly DesignPlatform[] = ['web', 'ios', 'android', 'adaptive'];

/** A rule with a name the agent can quote: "The Semantic-Reuse Rule" beats "see design.md". */
export interface NamedDesignRule {
	name: string;
	body: string;
}

/** A detector finding the project declares to be its identity, with the stated reason. */
export interface AcceptedDrift {
	rule: string;
	reason: string;
}

export interface ProductContext {
	/** Who this is for, concretely — a role in a situation, not "users". */
	audience?: string;
	/** What it makes possible that a neighbouring product could not truthfully claim. */
	positioning?: string;
	platform?: DesignPlatform;
	/** Whole file, for handing to the model verbatim. */
	raw: string;
}

export interface DesignSystemContext {
	/** Committed families, in the order the file lists them (display first by convention). */
	fonts: string[];
	/** Committed palette as lowercase hex, deduplicated. */
	colors: string[];
	namedRules: NamedDesignRule[];
	acceptedDrift: AcceptedDrift[];
	raw: string;
}

/** Памятка по одному виду компонента: заголовок — название вида, тело — что не забыть. */
export interface ComponentNote {
	name: string;
	body: string;
}

export interface ComponentNotesContext {
	notes: ComponentNote[];
	raw: string;
}

export interface DesignContext {
	product?: ProductContext;
	design?: DesignSystemContext;
	/**
	 * Третий слой контекста — памятки на момент СОЗДАНИЯ компонента.
	 *
	 * Детектор ловит то, что уже построено, и говорит числами. Памятка говорит словами и до того:
	 * у формы бывает состояние отправки, у таблицы — узкий экран, у пустого состояния — причина
	 * пустоты. Ни одно из этих упущений детектору не видно — на снимке страницы их просто нет.
	 */
	components?: ComponentNotesContext;
}

/**
 * Where the files live, in lookup order. Ours sit under `.vibe/` with the rest of the project's
 * Vibe configuration; the bare uppercase names are what other design skills write to the root, and
 * a project that already has them should not be asked to move them.
 */
export const PRODUCT_CONTEXT_PATHS: readonly string[] = ['.vibe/design/product.md', 'PRODUCT.md'];
export const DESIGN_SYSTEM_PATHS: readonly string[] = ['.vibe/design/design.md', 'DESIGN.md'];
export const COMPONENT_NOTES_PATHS: readonly string[] = ['.vibe/design/components.md', 'COMPONENTS.md'];

/** Section titles we accept: ours (Russian) first, then the English ones other tools write. */
const SECTION_ALIASES: Record<string, readonly string[]> = {
	audience: ['для кого', 'аудитория', 'audience', 'who is this for', 'who is it for', 'who'],
	positioning: ['позиционирование', 'positioning', 'promise'],
	platform: ['платформа', 'platform', 'surface'],
	colors: ['цвета', 'палитра', 'colors', 'colours', 'color', 'palette'],
	typography: ['типографика', 'шрифты', 'typography', 'type', 'fonts'],
	namedRules: ['именованные правила', 'named rules', 'rules'],
	detector: ['детектор', 'осознанные отклонения', 'detector', 'accepted drift', 'ignores'],
};

const HEX_COLOR = /#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi;
/** `**The Pixel-For-Moments Rule.**` — a bold lead-in is what makes a rule quotable. */
const NAMED_RULE_LEAD = /^\*\*(?<name>[^*]+?)\.?\*\*\s*(?<body>[\s\S]*)$/;
/** `- rule-id — reason` / `- rule-id: reason`; the id is kebab-case like our finding ids. */
const DRIFT_LINE = /^[-*]\s*`?(?<rule>[a-z][a-z0-9-]{2,})`?\s*(?:[—–:-]\s*(?<reason>.+))?$/i;

interface Section {
	key: string | undefined;
	title: string;
	body: string;
}

const normaliseTitle = (title: string): string =>
	title.toLowerCase().replace(/[`*_#:.]/g, '').replace(/\s+/g, ' ').trim();

const keyForTitle = (title: string): string | undefined => {
	const normalised = normaliseTitle(title);
	for (const [key, aliases] of Object.entries(SECTION_ALIASES)) {
		if (aliases.some(alias => normalised === alias || normalised.startsWith(alias + ' '))) {
			return key;
		}
	}
	return undefined;
};

/**
 * Splits markdown into flat sections by any heading level.
 *
 * Flat, not nested, on purpose: `### Named Rules` appears under both Colors and Typography in a
 * real design system, and the rules are wanted from every one of them.
 */
function splitSections(markdown: string): Section[] {
	const sections: Section[] = [];
	let current: Section | undefined;
	for (const line of markdown.split(/\r?\n/)) {
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			current = { key: keyForTitle(heading[2]), title: heading[2].trim(), body: '' };
			sections.push(current);
			continue;
		}
		if (current) {
			current.body += line + '\n';
		}
	}
	return sections;
}

const sectionBodies = (sections: readonly Section[], key: string): string[] =>
	sections.filter(section => section.key === key).map(section => section.body);

/** First non-empty line, stripped of list/bold markers — how a one-answer section reads. */
const firstAnswer = (body: string | undefined): string | undefined => {
	if (!body) {
		return undefined;
	}
	for (const line of body.split('\n')) {
		const text = line.replace(/^[-*>\s]+/, '').replace(/\*\*/g, '').trim();
		if (text) {
			return text;
		}
	}
	return undefined;
};

/** Paragraphs of a section — blank line separated, so a named rule can span several lines. */
const paragraphs = (body: string): string[] =>
	body.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);

export function parseProductContext(raw: string | undefined | null): ProductContext | undefined {
	if (!raw || !raw.trim()) {
		return undefined;
	}
	const sections = splitSections(raw);
	const platformAnswer = firstAnswer(sectionBodies(sections, 'platform')[0])?.toLowerCase() ?? '';
	const platform = DESIGN_PLATFORMS.find(candidate => platformAnswer.includes(candidate));
	return {
		audience: firstAnswer(sectionBodies(sections, 'audience')[0]),
		positioning: firstAnswer(sectionBodies(sections, 'positioning')[0]),
		platform,
		raw,
	};
}

export function parseDesignSystem(raw: string | undefined | null): DesignSystemContext | undefined {
	if (!raw || !raw.trim()) {
		return undefined;
	}
	const sections = splitSections(raw);

	const colors: string[] = [];
	for (const body of sectionBodies(sections, 'colors')) {
		for (const match of body.matchAll(HEX_COLOR)) {
			const hex = match[0].toLowerCase();
			if (!colors.includes(hex)) {
				colors.push(hex);
			}
		}
	}

	const fonts: string[] = [];
	for (const body of sectionBodies(sections, 'typography')) {
		// Families are the backticked names; prose around them is for the reader, not for us.
		for (const match of body.matchAll(/`([^`]+)`/g)) {
			const family = match[1].split(',')[0].trim().replace(/["']/g, '');
			if (family && !/^\d/.test(family) && !fonts.includes(family)) {
				fonts.push(family);
			}
		}
	}

	const namedRules: NamedDesignRule[] = [];
	for (const body of sectionBodies(sections, 'namedRules')) {
		for (const paragraph of paragraphs(body)) {
			const lead = NAMED_RULE_LEAD.exec(paragraph);
			if (lead?.groups) {
				namedRules.push({
					name: lead.groups.name.trim(),
					body: lead.groups.body.replace(/\s+/g, ' ').trim(),
				});
			}
		}
	}

	const acceptedDrift: AcceptedDrift[] = [];
	for (const body of sectionBodies(sections, 'detector')) {
		for (const line of body.split('\n')) {
			const match = DRIFT_LINE.exec(line.trim());
			if (match?.groups && !acceptedDrift.some(drift => drift.rule === match.groups!.rule)) {
				acceptedDrift.push({
					rule: match.groups.rule.toLowerCase(),
					reason: match.groups.reason?.trim() ?? '',
				});
			}
		}
	}

	return { fonts, colors, namedRules, acceptedDrift, raw };
}

/**
 * Разбирает памятки по компонентам: каждый заголовок — вид компонента, тело — что не забыть.
 *
 * Разбор нарочно грубый. Файл пишет человек своими словами, и единственное, что нам нужно
 * машинно, — уметь достать памятку по названию вида; всё остальное уходит модели как есть.
 * Заголовок без тела пропускается: пустой раздел — это заготовка, а не требование.
 */
export function parseComponentNotes(raw: string | undefined | null): ComponentNotesContext | undefined {
	if (!raw || !raw.trim()) {
		return undefined;
	}
	const notes: ComponentNote[] = [];
	for (const section of splitSections(raw)) {
		const body = section.body.trim();
		if (section.title && body) {
			notes.push({ name: section.title, body });
		}
	}
	return { notes, raw };
}

/** The drift entry covering `rule`, if the project declared it deliberate. */
export function acceptedDriftFor(context: DesignContext | undefined, rule: string): AcceptedDrift | undefined {
	return context?.design?.acceptedDrift.find(drift => drift.rule === rule);
}

/**
 * Accepted-drift ids that no rule answers to.
 *
 * A typo silently switches off nothing, which is worse than an error: the project believes a
 * finding is accepted while the detector keeps reporting it. The doctor surfaces this list.
 */
export function unknownAcceptedDrift(
	context: DesignContext | undefined,
	knownRuleIds: readonly string[],
): string[] {
	return (context?.design?.acceptedDrift ?? [])
		.map(drift => drift.rule)
		.filter(rule => !knownRuleIds.includes(rule));
}

/** True when there is enough context for a generator to stop guessing. */
export function hasUsableContext(context: DesignContext | undefined): boolean {
	return !!(context?.product?.audience || context?.product?.positioning
		|| context?.design?.fonts.length || context?.design?.colors.length || context?.design?.namedRules.length);
}

// ---------------------------------------------------------------------------------------------
// writers — one shape for the files we create, so a second run edits rather than reinvents
// ---------------------------------------------------------------------------------------------

export interface ProductContextDraft {
	name: string;
	audience?: string;
	positioning?: string;
	platform?: DesignPlatform;
	/** Free notes the interview collected but that have no section of their own. */
	notes?: string;
}

export function renderProductContext(draft: ProductContextDraft): string {
	const lines = [
		`# Продукт: ${draft.name}`,
		'',
		'> Стратегия продукта для дизайн-решений: для кого, ради чего, на какой платформе.',
		'> Файл ваш — правьте свободно; каждая дизайн-команда читает его перед генерацией.',
		'',
		'## Для кого',
		'',
		draft.audience?.trim() || '_Не заполнено. Опишите конкретного человека в конкретной ситуации, а не «пользователей»._',
		'',
		'## Позиционирование',
		'',
		draft.positioning?.trim() || '_Не заполнено. Что становится возможным — и чего соседний продукт не может честно обещать._',
		'',
		'## Платформа',
		'',
		draft.platform ?? 'web',
	];
	if (draft.notes?.trim()) {
		lines.push('', '## Заметки', '', draft.notes.trim());
	}
	return lines.join('\n') + '\n';
}

export interface DesignSystemDraft {
	name: string;
	/** Colours as hex with a short role each: `{ hex, role }`. */
	colors: readonly { hex: string; role: string }[];
	fonts: readonly { family: string; role: string }[];
	/** Type scale: name plus the size it was measured at. */
	typeScale: readonly { name: string; sizePx: number; weight: number; lineHeight: number }[];
	radiiPx: readonly number[];
	shadows: readonly string[];
	namedRules: readonly NamedDesignRule[];
	acceptedDrift: readonly AcceptedDrift[];
	/** Where the numbers came from, so nobody mistakes a measurement for a decision. */
	source?: string;
}

export function renderDesignSystem(draft: DesignSystemDraft): string {
	const lines = [
		`# Дизайн-система: ${draft.name}`,
		'',
		'> Визуальный мир продукта: палитра, типографика, ритм, именованные правила.',
		draft.source ? `> Снято с реального состояния: ${draft.source}. Замер — не решение: вычитайте и утвердите.` : '> Файл ваш — правьте свободно.',
		'',
		'## Цвета',
		'',
	];
	lines.push(draft.colors.length
		? draft.colors.map(color => `- ${color.role}: \`${color.hex}\``).join('\n')
		: '_Палитра не заявлена._');

	lines.push('', '## Типографика', '');
	lines.push(draft.fonts.length
		? draft.fonts.map(font => `**${font.role}:** \`${font.family}\``).join('\n')
		: '_Гарнитуры не заявлены._');

	if (draft.typeScale.length) {
		lines.push('', '### Шкала', '');
		lines.push(draft.typeScale
			.map(step => `- **${step.name}** — ${step.sizePx}px, вес ${step.weight}, интерлиньяж ${step.lineHeight.toFixed(2)}`)
			.join('\n'));
	}

	if (draft.radiiPx.length || draft.shadows.length) {
		lines.push('', '## Форма и глубина', '');
		if (draft.radiiPx.length) {
			lines.push(`- Радиусы: ${draft.radiiPx.map(radius => `${radius}px`).join(', ')}`);
		}
		for (const shadow of draft.shadows) {
			lines.push(`- Тень: \`${shadow}\``);
		}
	}

	lines.push('', '### Именованные правила', '');
	lines.push(draft.namedRules.length
		? draft.namedRules.map(rule => `**${rule.name}.** ${rule.body}`).join('\n\n')
		: '_Правил пока нет. Именованное правило — инвариант, на который можно ссылаться в споре: «Правило переиспользования семантики. Предупреждение — жёлтый бренда, ошибка — багровый; новых оттенков состояния не вводим»._');

	lines.push(
		'', '## Детектор', '',
		'Находки-дрейф, которые для этого продукта — идентичность, а не дефект. Формат: `id-правила — причина`.',
		'Абсолютный пол качества (контраст, зоны нажатия, порядок заголовков, оверфлоу, битые картинки) так не отключается.',
		'',
	);
	lines.push(draft.acceptedDrift.length
		? draft.acceptedDrift.map(drift => `- ${drift.rule} — ${drift.reason}`).join('\n')
		: '_Ничего не принято._');

	return lines.join('\n') + '\n';
}
