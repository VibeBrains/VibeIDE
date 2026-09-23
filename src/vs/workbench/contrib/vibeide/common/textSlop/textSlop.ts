/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The deterministic detector of AI-writing tells in prose — the part of a check that cannot be argued with.
 *
 * Why rules and not a model asked «does this read as AI»: a model answers differently on the same text twice,
 * cannot point at the line, and grades its own writing kindly. Rules read what is on the page the same way
 * every time, and every finding carries its line and the text it matched. What rules cannot see — an
 * invented fact, a meaning that shifted while smoothing — is the reviewer's job (the `anti-slop` skill); the
 * score is a floor, not a verdict.
 *
 * The method follows `misbahsy/anti-ai-slop` (MIT): masked non-prose, word lists and sentence templates, rates
 * for devices that are ordinary once and a tic three times, rhythm, formatting and fixed arithmetic. It is the
 * twin of VibeIDEA's `TextSlop.kt`, and the shared vectors in the `.vibe` set hold both to one answer.
 *
 * Pure: text and a compiled catalogue in, a report out.
 */

import { CompiledSlopCatalog, CompiledSlopRule, SlopLang, SlopRule, SlopScoring, SlopSeverity, slopSeverityRank } from './slopCatalog.js';

/** How often a habit occurs: `count` times, `perThousand` per thousand words, on `lines` (the first few, from 1). */
export interface SlopDensity {
	readonly count: number;
	readonly perThousand: number;
	readonly lines: readonly number[];
}

/**
 * One tell in a text: which rule, where, what it matched and how to fix it. Lines and columns start at 1. A habit
 * rule points at its first occurrence and carries the rest as `density`: its problem is the count, not any one
 * sentence.
 */
export interface SlopFinding {
	readonly rule: string;
	readonly name: string;
	readonly severity: SlopSeverity;
	readonly line: number;
	readonly column: number;
	readonly start: number;
	readonly end: number;
	readonly match: string;
	readonly fix: string;
	readonly density?: SlopDensity;
}

/** What one rule cost the text, with the count that produced the cost. */
export interface SlopDeduction {
	readonly rule: string;
	readonly name: string;
	readonly severity: SlopSeverity;
	readonly count: number;
	readonly points: number;
}

export interface SlopReport {
	readonly score: number;
	readonly passed: boolean;
	readonly passScore: number;
	readonly maxSeverity: SlopSeverity;
	/** Rules whose findings are above `maxSeverity`: any one of them fails the text whatever the score. */
	readonly blocking: readonly string[];
	readonly words: number;
	readonly findings: readonly SlopFinding[];
	readonly deductions: readonly SlopDeduction[];
}

/**
 * The findings and the score of a text. Line endings are read as '\n' whatever the file was saved with — front matter,
 * paragraphs and line numbers are all found by it — so positions refer to the text in that form.
 */
export function analyzeTextSlop(source: string, catalog: CompiledSlopCatalog): SlopReport {
	const text = source.replace(/\r\n?/g, '\n');
	const masked = maskNonProse(text);
	const context = new Context(text, masked, lineStartsOf(text), suppressedLines(text.split('\n')), paragraphsOf(masked));
	const sentences = sentencesOf(masked);
	const raw: SlopFinding[] = [];
	for (const compiled of catalog.rules) {
		const rule = compiled.rule;
		switch (rule.kind) {
			case 'words':
			case 'phrases':
			case 'regex': raw.push(...lexical(compiled, context)); break;
			case 'opener': raw.push(...openers(compiled, context, sentences)); break;
			case 'density': {
				const finding = density(compiled, context);
				if (finding) {
					raw.push(finding);
				}
				break;
			}
			case 'invisible': raw.push(...invisible(rule, context)); break;
			case 'rhythm-uniform': raw.push(...uniformRhythm(rule, context, sentences)); break;
			case 'rhythm-fragments': raw.push(...stackedFragments(rule, context, sentences)); break;
			case 'decorative-bold': raw.push(...decorativeBold(rule, context)); break;
			case 'heading-stub': raw.push(...headingStubs(rule, context)); break;
			case 'title-case': raw.push(...titleCase(rule, context)); break;
		}
	}
	const findings = dedupeSlopFindings(raw.filter(finding => !catalog.allow.some(allowed => allowed.test(finding.match))))
		.sort((a, b) => a.line - b.line || a.column - b.column || compareIds(a.rule, b.rule));
	return scoreSlopFindings(findings, catalog.scoring, wordCount(masked));
}

// --- masking: never flag what the writer did not write as prose ---

const MASKS: readonly RegExp[] = [
	/^```[\s\S]*?^```/gm,
	/^~~~[\s\S]*?^~~~/gm,
	/<!--[\s\S]*?-->/g,
	/`[^`\n]+`/g,
	/^(?:\t| {4,})\S.*$/gm,
	/^\s*>.*$/gm,
	/\]\([^)\s]+\)/g,
	/https?:\/\/\S+/g,
	// Quoted material is someone else's words, a UI label or an example — Russian quotes included.
	/"(?:[^"\n]|\n(?!\s*\n)){1,400}"/g,
	/“(?:[^”\n]|\n(?!\s*\n)){1,400}”/g,
	/«(?:[^»\n]|\n(?!\s*\n)){1,400}»/g,
	/„(?:[^“\n]|\n(?!\s*\n)){1,400}“/g,
];

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

/** Non-prose replaced by spaces, newlines and offsets kept, so every position still points into the original. */
export function maskNonProse(text: string): string {
	const chars = text.split('');
	const blank = (start: number, end: number) => {
		for (let i = start; i < Math.min(end, chars.length); i++) {
			if (chars[i] !== '\n') {
				chars[i] = ' ';
			}
		}
	};
	const front = FRONTMATTER.exec(text);
	if (front) {
		blank(front.index, front.index + front[0].length);
	}
	for (const pattern of MASKS) {
		for (const m of text.matchAll(pattern)) {
			blank(m.index, m.index + m[0].length);
		}
	}
	return chars.join('');
}

// --- suppression ---

/** `<!-- slop-ignore ID[, ID…] [— reason] -->`; `ALL` suppresses every rule. */
const IGNORE_SOURCE = '<!--\\s*slop-ignore\\s+([A-Za-z0-9_, -]+?)(?:\\s+[—–]+\\s+.*?|\\s+--\\s+.*?)?\\s*-->';

/**
 * Line → rule ids suppressed there. A directive at the end of a line covers it and the next one; a directive
 * alone on its line covers the paragraph below — the sentence being excused usually wraps.
 */
function suppressedLines(lines: readonly string[]): Map<number, Set<string>> {
	const out = new Map<number, Set<string>>();
	const add = (line: number, ids: Iterable<string>) => {
		let set = out.get(line);
		if (!set) {
			set = new Set<string>();
			out.set(line, set);
		}
		for (const id of ids) {
			set.add(id);
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const m = new RegExp(IGNORE_SOURCE).exec(lines[i]);
		if (!m) {
			continue;
		}
		const ids = m[1].split(/[, ]/).map(id => id.trim().toUpperCase()).filter(id => id.length > 0);
		add(i, ids);
		if (lines[i].replace(new RegExp(IGNORE_SOURCE, 'g'), '').trim().length > 0) {
			add(i + 1, ids);
			continue;
		}
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim().length === 0) {
				break;
			}
			add(j, ids);
		}
	}
	return out;
}

// --- positions, paragraphs and sentences ---

interface Paragraph {
	readonly start: number;
	readonly end: number;
	readonly lang: Exclude<SlopLang, 'any'>;
}

interface Sentence {
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly paragraph: Paragraph | undefined;
}

const WHITESPACE = /\s+/u;
const MATCH_CHARS = 90;

class Context {
	constructor(
		readonly text: string,
		readonly masked: string,
		private readonly lineStarts: readonly number[],
		private readonly suppress: ReadonlyMap<number, ReadonlySet<string>>,
		readonly paragraphs: readonly Paragraph[],
	) { }

	/** Zero-based line of an offset. */
	lineOf(offset: number): number {
		let lo = 0;
		let hi = this.lineStarts.length - 1;
		while (lo < hi) {
			const mid = Math.floor((lo + hi + 1) / 2);
			if (this.lineStarts[mid] <= offset) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		return lo;
	}

	suppressed(rule: string, offset: number): boolean {
		const ids = this.suppress.get(this.lineOf(offset));
		return !!ids && (ids.has(rule.toUpperCase()) || ids.has('ALL'));
	}

	langAt(offset: number): SlopLang | undefined {
		return this.paragraphs.find(paragraph => offset >= paragraph.start && offset < paragraph.end)?.lang;
	}

	reads(rule: SlopRule, offset: number): boolean {
		return rule.lang === 'any' || this.langAt(offset) === rule.lang;
	}

	finding(rule: SlopRule, start: number, end: number, match: string = this.text.substring(start, end)): SlopFinding {
		const line = this.lineOf(start);
		return {
			rule: rule.id,
			name: rule.name,
			severity: rule.severity,
			line: line + 1,
			column: start - this.lineStarts[line] + 1,
			start,
			end,
			match: match.split(WHITESPACE).filter(part => part.length > 0).join(' ').slice(0, MATCH_CHARS),
			fix: rule.fix,
		};
	}
}

function lineStartsOf(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			starts.push(i + 1);
		}
	}
	return starts;
}

const BLANK_LINE = /\n\s*\n/g;
const TOKEN = /[\p{L}\p{N}_./\\'’-]+/gu;
/** A block with fewer ordinary words than this takes the language of the document. */
const LANGUAGE_EVIDENCE = 4;

/**
 * Blocks between blank lines, each with its language — counted in ordinary words, not letters. A Russian line
 * is full of Latin names (a heading with the product's name, `## TypeScript — vtsls`), and by letters it read
 * as English, so the English rule on the em dash fired on Russian grammar. Names, acronyms and identifiers say
 * nothing about the language of the sentence around them.
 */
function paragraphsOf(masked: string): Paragraph[] {
	const blocks: Array<[number, number]> = [];
	let from = 0;
	for (const gap of masked.matchAll(BLANK_LINE)) {
		if (from < gap.index) {
			blocks.push([from, gap.index]);
		}
		from = gap.index + gap[0].length;
	}
	if (from < masked.length) {
		blocks.push([from, masked.length]);
	}
	const counts = blocks.map(([start, end]) => scriptCounts(masked.substring(start, end)));
	const document = languageOf(counts.reduce((sum, [ru]) => sum + ru, 0), counts.reduce((sum, [, en]) => sum + en, 0));
	const paragraphs: Paragraph[] = [];
	blocks.forEach(([start, end], index) => {
		const [ru, en] = counts[index];
		const lang = ru + en >= LANGUAGE_EVIDENCE ? languageOf(ru, en) : document;
		if (lang) {
			paragraphs.push({ start, end, lang });
		}
	});
	return paragraphs;
}

function languageOf(ru: number, en: number): Exclude<SlopLang, 'any'> | undefined {
	if (ru === 0 && en === 0) {
		return undefined;
	}
	return ru >= en ? 'ru' : 'en';
}

const LETTER = /\p{L}/u;
const UPPERCASE = /\p{Lu}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;
const NOT_A_WORD = /[\p{Nd}_./\\]/u;

/** Ordinary words by script; a name with an inner capital, an acronym, a number or a path is none of them. */
function scriptCounts(block: string): [number, number] {
	let ru = 0;
	let en = 0;
	for (const token of block.matchAll(TOKEN)) {
		const word = trimChars(token[0], '\'’-.');
		if (word.length < 2 || NOT_A_WORD.test(word)) {
			continue;
		}
		if (UPPERCASE.test(word.slice(1))) {
			continue;
		}
		const chars = [...word];
		if (chars.every(char => !LETTER.test(char) || CYRILLIC.test(char))) {
			ru++;
		} else if (chars.every(char => !LETTER.test(char) || LATIN.test(char))) {
			en++;
		}
	}
	return [ru, en];
}

function trimChars(value: string, chars: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && chars.includes(value[start])) {
		start++;
	}
	while (end > start && chars.includes(value[end - 1])) {
		end--;
	}
	return value.substring(start, end);
}

/** Headings, tables, list items, link definitions and thematic breaks are not prose sentences. */
const SKIP_BLOCK = /^\s{0,3}(?:#{1,6}\s|\||[-*+]\s|\d+[.)]\s|\[|(?:[-*_]\s*){3,}$)/;
const SINGLE_NEWLINE = /(?<!\n)\n(?!\n)/g;
const LINE = /[^\n]+/g;

/** What a Unicode-aware `\b` means before a word: nothing word-like right before it. */
const WORD_START = '(?<![\\p{L}\\p{N}_])';

/**
 * A sentence ends at `.`, `!`, `?` or `…` followed by space and a capital or an opening quote — unless the period
 * closes an abbreviation or an initial, which is where a naive split invents a sentence of one word.
 */
const SENTENCE_SPLIT = new RegExp(
	`(?<!${WORD_START}\\p{Lu}\\.)` +
	`(?<!${WORD_START}(?:Mr|Ms|Dr|St|vs|etc|e\\.g|i\\.e|Fig|No|т\\.е|т\\.д|т\\.п|т\\. е|т\\. д|т\\. п|др|стр|рис|см|напр|ср|им|ул|гг|г)\\.)` +
	`(?<=[.!?…])["'»”)\\]]*\\s+(?=[\\p{Lu}"'«“(\\[])`,
	'u',
);

/** A short line ending in a colon introduces a list or a code block: a label, not a sentence of the rhythm. */
const FRAGMENT_WORDS = 6;

function sentencesOf(masked: string): Sentence[] {
	// Wrapped lines are one sentence: without flattening, word wrap would read as a stack of short sentences.
	const flow = masked.replace(SINGLE_NEWLINE, ' ');
	const paragraphs = paragraphsOf(masked);
	const out: Sentence[] = [];
	for (const block of flow.matchAll(LINE)) {
		const body = block[0];
		if (body.trim().length === 0 || SKIP_BLOCK.test(body)) {
			continue;
		}
		if (body.trimEnd().endsWith(':') && wordsIn(body) <= FRAGMENT_WORDS) {
			continue;
		}
		let cursor = 0;
		for (const piece of body.split(SENTENCE_SPLIT)) {
			const at = body.indexOf(piece, cursor);
			if (at < 0) {
				continue;
			}
			cursor = at + piece.length;
			if (piece.trim().length === 0) {
				continue;
			}
			const lead = piece.length - piece.trimStart().length;
			const start = block.index + at + lead;
			const end = block.index + at + piece.trimEnd().length;
			out.push({ start, end, text: piece.trim(), paragraph: paragraphs.find(paragraph => start >= paragraph.start && start < paragraph.end) });
		}
	}
	return out;
}

// --- the checks ---

function lexical(compiled: CompiledSlopRule, context: Context): SlopFinding[] {
	const out: SlopFinding[] = [];
	for (const pattern of compiled.patterns) {
		for (const m of context.masked.matchAll(pattern)) {
			if (m[0].trim().length === 0) {
				continue;
			}
			if (!context.reads(compiled.rule, m.index) || context.suppressed(compiled.rule.id, m.index)) {
				continue;
			}
			out.push(context.finding(compiled.rule, m.index, m.index + m[0].length));
		}
	}
	return out;
}

/** An opener counts only where a sentence starts: the same word in the middle of one is ordinary language. */
function openers(compiled: CompiledSlopRule, context: Context, sentences: readonly Sentence[]): SlopFinding[] {
	const rule = compiled.rule;
	// Matched only at the very start of the sentence, as Java's lookingAt() does.
	const anchored = compiled.patterns.map(pattern => new RegExp(pattern.source, `${pattern.flags.replace('g', '')}y`));
	const out: SlopFinding[] = [];
	for (const sentence of sentences) {
		if (rule.lang !== 'any' && sentence.paragraph?.lang !== rule.lang) {
			continue;
		}
		for (const pattern of anchored) {
			pattern.lastIndex = 0;
			const m = pattern.exec(sentence.text);
			if (!m) {
				continue;
			}
			if (!context.suppressed(rule.id, sentence.start)) {
				out.push(context.finding(rule, sentence.start, sentence.start + m[0].length));
			}
			break;
		}
	}
	return out;
}

const PER_THOUSAND = 1000;
const MAX_LINES_LISTED = 12;

/** Some devices are tells only in bulk: every «rather than» is defensible, three in a short post are a habit. */
function density(compiled: CompiledSlopRule, context: Context): SlopFinding | undefined {
	const rule = compiled.rule;
	const hits: Array<[number, number]> = [];
	for (const pattern of compiled.patterns) {
		for (const m of context.masked.matchAll(pattern)) {
			if (context.reads(rule, m.index)) {
				hits.push([m.index, m.index + m[0].length]);
			}
		}
	}
	// Two patterns of one rule can match the same words — a short form of the device and a longer one — and one
	// occurrence counted twice would make a habit out of two sentences.
	hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const occurrences: Array<[number, number]> = [];
	for (const hit of hits) {
		if (occurrences.length === 0 || hit[0] >= occurrences[occurrences.length - 1][1]) {
			occurrences.push(hit);
		}
	}
	if (occurrences.length < rule.minCount) {
		return undefined;
	}
	const words = rule.lang === 'any'
		? wordCount(context.masked)
		: context.paragraphs.filter(paragraph => paragraph.lang === rule.lang).reduce((sum, paragraph) => sum + wordCount(context.masked.substring(paragraph.start, paragraph.end)), 0);
	if (words === 0) {
		return undefined;
	}
	const rate = occurrences.length * PER_THOUSAND / words;
	if (rate < rule.thresholdPer1000) {
		return undefined;
	}
	const [firstStart, firstEnd] = occurrences[0];
	if (context.suppressed(rule.id, firstStart)) {
		return undefined;
	}
	const lines = [...new Set(occurrences.map(([start]) => context.lineOf(start) + 1))].slice(0, MAX_LINES_LISTED);
	return { ...context.finding(rule, firstStart, firstEnd), density: { count: occurrences.length, perThousand: rate, lines } };
}

/** Invisible characters are looked for in the raw text: a zero-width space inside a code fence still breaks a copy. */
function invisible(rule: SlopRule, context: Context): SlopFinding[] {
	const out: SlopFinding[] = [];
	const seenLines = new Set<number>();
	for (const removed of removableCharacters(context.text)) {
		const line = context.lineOf(removed.index);
		if (seenLines.has(line) || context.suppressed(rule.id, removed.index)) {
			continue;
		}
		seenLines.add(line);
		const width = removed.codePoint > 0xFFFF ? 2 : 1;
		out.push(context.finding(rule, removed.index, removed.index + width, `U+${removed.codePoint.toString(16).toUpperCase().padStart(4, '0')}`));
	}
	return out;
}

const RHYTHM_RUN = 4;
const RHYTHM_SPREAD = 2;
const RHYTHM_MIN_WORDS = 8;

/** Four sentences in a row within two words of each other read as a metronome. */
function uniformRhythm(rule: SlopRule, context: Context, sentences: readonly Sentence[]): SlopFinding[] {
	const out: SlopFinding[] = [];
	const lengths = sentences.map(sentence => wordsIn(sentence.text));
	let run = 1;
	for (let i = 1; i < lengths.length; i++) {
		run = Math.abs(lengths[i] - lengths[i - 1]) <= RHYTHM_SPREAD && lengths[i] >= RHYTHM_MIN_WORDS ? run + 1 : 1;
		if (run === RHYTHM_RUN) {
			const first = sentences[i - RHYTHM_RUN + 1];
			if (!context.suppressed(rule.id, first.start)) {
				out.push(context.finding(rule, first.start, first.end));
			}
		}
	}
	return out;
}

/** Four short sentences in a row are manufactured punch. */
function stackedFragments(rule: SlopRule, context: Context, sentences: readonly Sentence[]): SlopFinding[] {
	const out: SlopFinding[] = [];
	let run = 0;
	sentences.forEach((sentence, i) => {
		run = wordsIn(sentence.text) <= FRAGMENT_WORDS ? run + 1 : 0;
		if (run === RHYTHM_RUN) {
			const first = sentences[i - RHYTHM_RUN + 1];
			if (!context.suppressed(rule.id, first.start)) {
				out.push(context.finding(rule, first.start, first.end));
			}
		}
	});
	return out;
}

const BOLD = /(?<![\n*])\s\*\*[^*\n]{1,60}[^*.:\n]\*\*(?![:.\n])/g;
const LIST_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s*$/;

/** Bold in the middle of a sentence decorates; a bold label opening a list item is structure. */
function decorativeBold(rule: SlopRule, context: Context): SlopFinding[] {
	const out: SlopFinding[] = [];
	for (const m of context.masked.matchAll(BOLD)) {
		const lineStart = context.masked.lastIndexOf('\n', m.index) + 1;
		if (LIST_PREFIX.test(context.masked.substring(lineStart, m.index + 1))) {
			continue;
		}
		if (!context.reads(rule, m.index) || context.suppressed(rule.id, m.index)) {
			continue;
		}
		out.push(context.finding(rule, m.index + 1, m.index + m[0].length));
	}
	return out;
}

const HEADING = /^\s{0,3}#{1,6}\s+.+$/gm;

function headingsOf(masked: string): Array<{ readonly start: number; readonly end: number }> {
	return [...masked.matchAll(HEADING)].map(m => ({ start: m.index, end: m.index + m[0].length }));
}

const STUB_WORDS = 25;
const STUB_SENTENCES = 2;

/** A heading over one or two sentences is scaffolding. */
function headingStubs(rule: SlopRule, context: Context): SlopFinding[] {
	const heads = headingsOf(context.masked);
	const out: SlopFinding[] = [];
	heads.forEach((head, i) => {
		const end = i + 1 < heads.length ? heads[i + 1].start : context.masked.length;
		const body = context.masked.substring(head.end, end).trim();
		if (body.length === 0 || wordsIn(body) >= STUB_WORDS || sentencesOf(body).length >= STUB_SENTENCES) {
			return;
		}
		if (!context.suppressed(rule.id, head.start)) {
			out.push(context.finding(rule, head.start, head.end));
		}
	});
	return out;
}

const TITLE_WORD_MIN = 3;
const TITLE_WORDS_MIN = 3;
const NOT_A_TITLE_WORD = /[\p{Nd}./_]/u;

/** Title Case in a heading: English style books do not ask for it, and Russian never has it. */
function titleCase(rule: SlopRule, context: Context): SlopFinding[] {
	const out: SlopFinding[] = [];
	for (const head of headingsOf(context.masked)) {
		const heading = context.masked.substring(head.start, head.end).trim().replace(/^#+/, '').trim();
		const words = heading.split(WHITESPACE).map(word => trimChars(word, ':,.()«»"'));
		// A name with an inner capital, an acronym, a version or a path is spelled that way by its owner.
		const content = words.filter(word =>
			word.length > TITLE_WORD_MIN && LETTER.test(word[0]) && !UPPERCASE.test(word.slice(1)) && !NOT_A_TITLE_WORD.test(word));
		if (content.length < TITLE_WORDS_MIN || !content.every(word => UPPERCASE.test(word[0]))) {
			continue;
		}
		if (!context.suppressed(rule.id, head.start)) {
			out.push(context.finding(rule, head.start, head.end));
		}
	}
	return out;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

function wordCount(text: string): number {
	return text.match(WORD)?.length ?? 0;
}

function wordsIn(sentence: string): number {
	return sentence.split(WHITESPACE).filter(part => part.length > 0).length;
}

// --- invisible characters ---

interface RemovableCharacter {
	readonly index: number;
	readonly codePoint: number;
}

const WAVING_BLACK_FLAG = 0x1F3F4;
const TAG_TERMINATOR = 0xE007F;
const TAG_PRINTABLE_FIRST = 0xE0020;
const TAG_PRINTABLE_LAST = 0xE007E;
const FLAG_TAGS_MIN = 2;
const FLAG_TAGS_MAX = 6;

/** Characters that render as nothing or reorder a line, as VibeIDEA's sanitizer finds them. */
function removableCharacters(text: string): RemovableCharacter[] {
	const out: RemovableCharacter[] = [];
	let index = 0;
	while (index < text.length) {
		const codePoint = text.codePointAt(index)!;
		// A subdivision flag is the one honest use of the tag block, so it is skipped whole.
		const flag = flagSequenceLength(text, index);
		if (flag > 0) {
			index += flag;
			continue;
		}
		if ((isInvisible(codePoint) && !isJoinerInScript(text, index)) || isBidiControl(codePoint)) {
			out.push({ index, codePoint });
		}
		index += codePoint > 0xFFFF ? 2 : 1;
	}
	return out;
}

/** Length of a legitimate «flag + tags + terminator» sequence starting at `index`, or 0. */
function flagSequenceLength(text: string, index: number): number {
	if (text.codePointAt(index) !== WAVING_BLACK_FLAG) {
		return 0;
	}
	let at = index + 2;
	let tags = 0;
	while (at < text.length) {
		const codePoint = text.codePointAt(at)!;
		if (codePoint >= TAG_PRINTABLE_FIRST && codePoint <= TAG_PRINTABLE_LAST) {
			tags++;
			if (tags > FLAG_TAGS_MAX) {
				return 0;
			}
			at += 2;
			continue;
		}
		if (codePoint === TAG_TERMINATOR && tags >= FLAG_TAGS_MIN && tags <= FLAG_TAGS_MAX) {
			return at + 2 - index;
		}
		return 0;
	}
	return 0;
}

/**
 * A zero-width joiner between characters of a script or emoji is part of the text (👨‍👩‍👧, Arabic, Indic); next to
 * Latin it has no honest use and splits a word so a filter misses it.
 */
function isJoinerInScript(text: string, index: number): boolean {
	if (text.codePointAt(index) !== 0x200D || index === 0) {
		return false;
	}
	const before = codePointBefore(text, index);
	const afterAt = index + 1;
	if (afterAt >= text.length) {
		return false;
	}
	return isScriptOrEmoji(before) && isScriptOrEmoji(text.codePointAt(afterAt)!);
}

function codePointBefore(text: string, index: number): number {
	const low = text.charCodeAt(index - 1);
	if (low >= 0xDC00 && low <= 0xDFFF && index >= 2) {
		const high = text.charCodeAt(index - 2);
		if (high >= 0xD800 && high <= 0xDBFF) {
			return text.codePointAt(index - 2)!;
		}
	}
	return low;
}

function isScriptOrEmoji(codePoint: number): boolean {
	return codePoint >= 0x0590 && !isInvisible(codePoint);
}

function isInvisible(codePoint: number): boolean {
	return codePoint === 0x00AD // soft hyphen
		|| (codePoint >= 0x200B && codePoint <= 0x200D) // zero-width space, non-joiner, joiner
		|| codePoint === 0xFEFF // zero-width no-break space (a BOM in the middle of text)
		|| (codePoint >= 0x2060 && codePoint <= 0x2064) // word joiner, invisible operators
		|| (codePoint >= 0xE0000 && codePoint <= 0xE007F); // tag characters: render as nothing, carry hidden text
}

/** The embedding, override and isolate controls that reorder a line; LRM and RLM are marks of honest bilingual text. */
function isBidiControl(codePoint: number): boolean {
	return (codePoint >= 0x202A && codePoint <= 0x202E) || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

// --- scoring ---

function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One problem counts once, at its highest severity: a faux-insight setup that contains a weasel phrase is a
 * single thing to fix, and counting it twice buries the real finding under a near-duplicate.
 */
export function dedupeSlopFindings(findings: readonly SlopFinding[]): SlopFinding[] {
	const ranked = [...findings].sort((a, b) =>
		slopSeverityRank(b.severity) - slopSeverityRank(a.severity) || (a.start - a.end) - (b.start - b.end) || a.start - b.start);
	const kept: SlopFinding[] = [];
	for (const finding of ranked) {
		const covered = kept.some(k =>
			(k.start <= finding.start && finding.end <= k.end) || (k.rule === finding.rule && finding.start < k.end && k.start < finding.end));
		if (!covered) {
			kept.push(finding);
		}
	}
	return kept;
}

export function scoreSlopFindings(findings: readonly SlopFinding[], scoring: SlopScoring, words: number): SlopReport {
	const groups = new Map<string, SlopFinding[]>();
	for (const finding of findings) {
		const group = groups.get(finding.rule);
		if (group) {
			group.push(finding);
		} else {
			groups.set(finding.rule, [finding]);
		}
	}
	const deductions: SlopDeduction[] = [...groups.keys()].sort(compareIds).map(rule => {
		const group = groups.get(rule)!;
		const severity = group[0].severity;
		const base = scoring.severityPoints[severity];
		const raw = base + (group.length - 1) * scoring.repeatPoints[severity];
		return { rule, name: group[0].name, severity, count: group.length, points: Math.min(raw, base * scoring.ruleCapMultiplier) };
	});
	const value = Math.max(scoring.floor, scoring.start - deductions.reduce((sum, deduction) => sum + deduction.points, 0));
	const score = Math.round(value * 10) / 10;
	const maxRank = slopSeverityRank(scoring.maxSeverity);
	const blocking = [...new Set(findings.filter(finding => slopSeverityRank(finding.severity) > maxRank).map(finding => finding.rule))].sort(compareIds);
	return {
		score,
		passed: score >= scoring.passScore && blocking.length === 0,
		passScore: scoring.passScore,
		maxSeverity: scoring.maxSeverity,
		blocking,
		words,
		findings,
		deductions,
	};
}
