/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The catalogue of AI-writing tells («нейрослоп»): what to look for in prose, what each costs, and when a
 * text passes.
 *
 * Data, not code. The lists live in the shared `.vibe` set (`slop/catalog.jsonc`) and ship inside the build,
 * never seeded into a project: a seeded copy would freeze today's lists the way a seeded base-language file
 * freezes today's wording. A project narrows or extends the catalogue with `.vibe/slop.json`.
 *
 * The same catalogue drives VibeIDEA's detector (`TextSlop.kt`); this is its TypeScript twin, and the shared
 * test vectors (`testVectors/textSlop.json`) keep the two from drifting apart. The regular expressions are
 * written for Java; the ones the catalogue carries compile unchanged in JavaScript with the `u` flag, and the
 * Russian ones avoid `\b`, which knows only ASCII here.
 *
 * Pure: text in, a catalogue out. A broken rule is dropped with a warning and the rest keep working.
 */

import { safeParseConfigJson } from '../vibeConfigJsonParser.js';

/** How much a finding weighs, weakest first; the catalogue's scoring prices each level. */
export type SlopSeverity = 'note' | 'minor' | 'major' | 'blocker';
export const SLOP_SEVERITIES: readonly SlopSeverity[] = ['note', 'minor', 'major', 'blocker'];

/** The weight's rank, for comparing severities. */
export function slopSeverityRank(severity: SlopSeverity): number {
	return SLOP_SEVERITIES.indexOf(severity);
}

/** What a rule matches with. The last six are checks whose logic is code; the catalogue only names and prices them. */
export type SlopKind =
	| 'words' | 'phrases' | 'opener' | 'regex' | 'density'
	| 'invisible' | 'rhythm-uniform' | 'rhythm-fragments' | 'decorative-bold' | 'heading-stub' | 'title-case';
const SLOP_KINDS: readonly SlopKind[] = [
	'words', 'phrases', 'opener', 'regex', 'density',
	'invisible', 'rhythm-uniform', 'rhythm-fragments', 'decorative-bold', 'heading-stub', 'title-case',
];

/**
 * Which paragraphs a rule reads. A Russian list has nothing to find in English and the other way round, and
 * a rule of one language's punctuation is wrong in the other: the em dash is a tell in English prose and
 * plain grammar in Russian.
 */
export type SlopLang = 'ru' | 'en' | 'any';
const SLOP_LANGS: readonly SlopLang[] = ['ru', 'en', 'any'];

export interface SlopRule {
	readonly id: string;
	readonly lang: SlopLang;
	readonly name: string;
	readonly severity: SlopSeverity;
	readonly kind: SlopKind;
	readonly fix: string;
	readonly items: readonly string[];
	readonly patterns: readonly string[];
	readonly caseSensitive: boolean;
	/** Density rules: fewer occurrences than this are ordinary language, however dense. */
	readonly minCount: number;
	/** Density rules: hits per thousand words from which the device reads as a habit. */
	readonly thresholdPer1000: number;
}

const DEFAULT_MIN_COUNT = 3;

/**
 * The fixed arithmetic: the same findings always give the same score. A text starts at `start`; the first
 * finding of a rule costs its severity's points, every repeat the repeat points, and no rule takes more than
 * `ruleCapMultiplier` times its first cost — one habit cannot sink a text on its own. A text passes at
 * `passScore` with nothing above `maxSeverity`.
 */
export interface SlopScoring {
	readonly start: number;
	readonly floor: number;
	readonly severityPoints: Readonly<Record<SlopSeverity, number>>;
	readonly repeatPoints: Readonly<Record<SlopSeverity, number>>;
	readonly ruleCapMultiplier: number;
	readonly passScore: number;
	readonly maxSeverity: SlopSeverity;
}

export interface SlopCatalog {
	readonly version: number;
	readonly scoring: SlopScoring;
	readonly rules: readonly SlopRule[];
}

export type SlopWarn = (warning: string) => void;

type JsonObject = { readonly [key: string]: unknown };

function objectOf(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringOf(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringsOf(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function oneOf<T extends string>(values: readonly T[], value: string | undefined): T | undefined {
	const normalized = value?.trim().toLowerCase();
	return values.find(candidate => candidate === normalized);
}

/** The catalogue from its JSONC text, or undefined when it cannot be used at all. */
export function parseSlopCatalog(text: string, warn: SlopWarn): SlopCatalog | undefined {
	const parsed = safeParseConfigJson(text);
	const root = parsed.ok ? objectOf(parsed.value) : undefined;
	if (!root) {
		warn(`catalog: ${parsed.ok ? 'the root is not an object' : parsed.reason}`);
		return undefined;
	}
	const scoring = scoringOf(objectOf(root.scoring), warn);
	if (!scoring) {
		return undefined;
	}
	return { version: numberOf(root.version) ?? 1, scoring, rules: slopRulesOf(root.rules, 'catalog', warn) };
}

/** Rules from a JSON array — the catalogue's and a project's own share one reader, so they cannot drift apart. */
export function slopRulesOf(value: unknown, where: string, warn: SlopWarn): SlopRule[] {
	const seen = new Set<string>();
	const rules: SlopRule[] = [];
	for (const entry of Array.isArray(value) ? value : []) {
		const rule = ruleOf(objectOf(entry), where, warn);
		if (!rule) {
			continue;
		}
		if (seen.has(rule.id.toUpperCase())) {
			warn(`${where}: rule ${rule.id} is declared twice; the first one is used`);
			continue;
		}
		seen.add(rule.id.toUpperCase());
		rules.push(rule);
	}
	return rules;
}

function ruleOf(o: JsonObject | undefined, where: string, warn: SlopWarn): SlopRule | undefined {
	if (!o) {
		return undefined;
	}
	const id = stringOf(o.id)?.trim();
	if (!id) {
		warn(`${where}: a rule without an id`);
		return undefined;
	}
	const kind = oneOf(SLOP_KINDS, stringOf(o.kind));
	if (!kind) {
		warn(`${where}: ${id} has an unknown kind`);
		return undefined;
	}
	const severity = oneOf(SLOP_SEVERITIES, stringOf(o.severity));
	if (!severity) {
		warn(`${where}: ${id} has an unknown severity`);
		return undefined;
	}
	const lang = oneOf(SLOP_LANGS, stringOf(o.lang) ?? 'any');
	if (!lang) {
		warn(`${where}: ${id} has an unknown lang`);
		return undefined;
	}
	const rule: SlopRule = {
		id,
		lang,
		name: stringOf(o.name) ?? id,
		severity,
		kind,
		fix: stringOf(o.fix) ?? '',
		items: stringsOf(o.items),
		patterns: stringsOf(o.patterns),
		caseSensitive: o.caseSensitive === true,
		minCount: numberOf(o.minCount) ?? DEFAULT_MIN_COUNT,
		thresholdPer1000: numberOf(o.thresholdPer1000) ?? 0,
	};
	const nothingToMatch = kind === 'words' || kind === 'phrases' || kind === 'opener'
		? rule.items.length === 0 && rule.patterns.length === 0
		: (kind === 'regex' || kind === 'density') && rule.patterns.length === 0;
	if (nothingToMatch) {
		warn(`${where}: ${id} has nothing to match`);
		return undefined;
	}
	return rule;
}

function scoringOf(o: JsonObject | undefined, warn: SlopWarn): SlopScoring | undefined {
	if (!o) {
		warn('catalog: no scoring');
		return undefined;
	}
	const points = (key: string): Record<SlopSeverity, number> | undefined => {
		const table = objectOf(o[key]);
		const out: Partial<Record<SlopSeverity, number>> = {};
		for (const severity of SLOP_SEVERITIES) {
			const value = numberOf(table?.[severity]);
			if (value === undefined) {
				return undefined;
			}
			out[severity] = value;
		}
		return out as Record<SlopSeverity, number>;
	};
	const severityPoints = points('severityPoints');
	const repeatPoints = points('repeatPoints');
	if (!severityPoints || !repeatPoints) {
		warn('catalog: severityPoints and repeatPoints must price every severity');
		return undefined;
	}
	return {
		start: numberOf(o.start) ?? 100,
		floor: numberOf(o.floor) ?? 0,
		severityPoints,
		repeatPoints,
		ruleCapMultiplier: numberOf(o.ruleCapMultiplier) ?? 3,
		passScore: numberOf(o.passScore) ?? 90,
		maxSeverity: oneOf(SLOP_SEVERITIES, stringOf(o.maxSeverity)) ?? 'minor',
	};
}

/** A rule with its patterns compiled once; the catalogue is matched against every text an agent writes. */
export interface CompiledSlopRule {
	readonly rule: SlopRule;
	readonly patterns: readonly RegExp[];
}

/**
 * The catalogue ready to match: patterns compiled, a project's allow-list compiled, broken patterns dropped.
 * Built once per catalogue text; a project's overrides make a new one (`applySlopOverrides`).
 */
export interface CompiledSlopCatalog {
	readonly scoring: SlopScoring;
	readonly rules: readonly CompiledSlopRule[];
	/** A finding whose matched text is entirely one of these is the project's real term, not a tell. */
	readonly allow: readonly RegExp[];
}

/** A letter, digit, underscore or hyphen: what a listed word must not be glued to on either side. */
const WORD_EDGE = '[\\p{L}\\p{N}_-]';

/** The list and template kinds — all a short fragment such as a headline or a button can be judged by. */
const LEXICAL_KINDS: ReadonlySet<SlopKind> = new Set<SlopKind>(['words', 'phrases', 'opener', 'regex']);

export function compileSlopCatalog(catalog: SlopCatalog, warn: SlopWarn): CompiledSlopCatalog {
	const rules: CompiledSlopRule[] = [];
	for (const rule of catalog.rules) {
		const compiled = compileSlopRule(rule, warn);
		if (compiled) {
			rules.push(compiled);
		}
	}
	return { scoring: catalog.scoring, rules, allow: [] };
}

/**
 * Only the list and template rules, for a short fragment such as a headline or a button: rhythm, density and
 * layout say nothing about one line of a page.
 */
export function lexicalSlopCatalog(catalog: CompiledSlopCatalog): CompiledSlopCatalog {
	return { ...catalog, rules: catalog.rules.filter(compiled => LEXICAL_KINDS.has(compiled.rule.kind)) };
}

export function compileSlopRule(rule: SlopRule, warn: SlopWarn): CompiledSlopRule | undefined {
	// Java's CASE_INSENSITIVE | UNICODE_CASE | MULTILINE; UNICODE_CHARACTER_CLASS is `unicodeClassesOf` below.
	const flags = rule.caseSensitive ? 'gmu' : 'gimu';
	const sources = rule.kind === 'words' || rule.kind === 'phrases'
		? [...optional(slopListPattern(rule.items)), ...rule.patterns]
		// An opener is matched at the start of a sentence by the detector; its pattern only recognises the words.
		: rule.kind === 'opener'
			? [...optional(slopOpenerPattern(rule.items)), ...rule.patterns]
			: [...rule.patterns];
	const patterns: RegExp[] = [];
	for (const source of sources) {
		try {
			patterns.push(new RegExp(unicodeClassesOf(source), flags));
		} catch (error) {
			warn(`${rule.id}: pattern does not compile: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (patterns.length === 0 && sources.length > 0) {
		return undefined;
	}
	return { rule, patterns };
}

/**
 * What `\w` matches in Java under UNICODE_CHARACTER_CLASS: letters of every script, marks, decimal digits, connector
 * punctuation and the joiners. A property escape at both ends: next to a `-` in a class the expansion stays an error,
 * as `\w` itself is there, instead of quietly becoming a range.
 */
const JAVA_WORD = '\\p{Alphabetic}\\u200C\\u200D\\p{M}\\p{Nd}\\p{Pc}';

/**
 * A catalogue pattern with Java's Unicode classes spelled out for JavaScript.
 *
 * VibeIDEA compiles the shared catalogue with UNICODE_CHARACTER_CLASS, where `\w`, `\d` and `\b` see every script;
 * in JavaScript they see ASCII only, even with the `u` flag. A project rule `\bсинерги\w*` then finds the word in one
 * product and nothing in the other, silently. Inside a class only `\w` and `\d` are rewritten: `[\b]` is a
 * backspace there, and a negated class cannot be spliced into another one.
 */
export function unicodeClassesOf(source: string): string {
	const boundary = `(?:(?<=[${JAVA_WORD}])(?![${JAVA_WORD}])|(?<![${JAVA_WORD}])(?=[${JAVA_WORD}]))`;
	const notBoundary = `(?:(?<=[${JAVA_WORD}])(?=[${JAVA_WORD}])|(?<![${JAVA_WORD}])(?![${JAVA_WORD}]))`;
	let out = '';
	let inClass = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === '\\' && i + 1 < source.length) {
			const escaped = source[++i];
			if (inClass) {
				out += escaped === 'w' ? JAVA_WORD : escaped === 'd' ? '\\p{Nd}' : `\\${escaped}`;
				continue;
			}
			switch (escaped) {
				case 'w': out += `[${JAVA_WORD}]`; break;
				case 'W': out += `[^${JAVA_WORD}]`; break;
				case 'd': out += '\\p{Nd}'; break;
				case 'D': out += '\\P{Nd}'; break;
				case 'b': out += boundary; break;
				case 'B': out += notBoundary; break;
				default: out += `\\${escaped}`;
			}
			continue;
		}
		if (char === '[' && !inClass) {
			inClass = true;
		} else if (char === ']' && inClass) {
			inClass = false;
		}
		out += char;
	}
	return out;
}

function optional(value: string | undefined): string[] {
	return value === undefined ? [] : [value];
}

/** Listed words and phrases as one alternation, longest first so a phrase wins over a word it contains. */
export function slopListPattern(items: readonly string[]): string | undefined {
	if (items.length === 0) {
		return undefined;
	}
	const body = [...items].sort((a, b) => b.length - a.length).map(slopItemPattern).join('|');
	return `(?<!${WORD_EDGE})(?:${body})(?!${WORD_EDGE})`;
}

/** Words that open a sentence, followed by a comma, a colon or just a space. */
function slopOpenerPattern(items: readonly string[]): string | undefined {
	if (items.length === 0) {
		return undefined;
	}
	const body = [...items].sort((a, b) => b.length - a.length).map(slopItemPattern).join('|');
	return `^(?:${body})(?=\\s*[,:]?\\s)`;
}

const REGEX_META = new Set('\\.[]{}()*+?^$|'.split(''));

/**
 * One list item as a pattern: literal text, any run of spaces for a space, either apostrophe, the Russian
 * «ё» also matching the plain «е» people type instead, and a trailing `*` on a word for any ending — Russian
 * inflects, and a list of every form of every word would be a list nobody maintains.
 */
export function slopItemPattern(text: string): string {
	return text.trim().split(/\s+/u).map(token => {
		const stem = token.endsWith('*') && token.length > 1;
		const body = [...(stem ? token.slice(0, -1) : token)].map(char => {
			if (char === 'ё') {
				return '[её]';
			}
			if (char === 'Ё') {
				return '[ЕЁ]';
			}
			if (char === '\'' || char === '’') {
				return '[\'’]';
			}
			return REGEX_META.has(char) ? `\\${char}` : char;
		}).join('');
		return stem ? `${body}\\p{L}*` : body;
	}).join('\\s+');
}

/** Patterns of a project's allowed terms, anchored: a finding is allowed only when its text is the whole term. */
export function slopAllowPatterns(items: readonly string[]): RegExp[] {
	return items.filter(item => item.trim().length > 0).map(item => new RegExp(`^(?:${slopItemPattern(item)})$`, 'iu'));
}

/**
 * A project's say over the catalogue: `.vibe/slop.json`.
 *
 * - `disable` — rule ids that do not apply here;
 * - `allow` — the project's real terms, in the catalogue's notation (a trailing `*` on a word for any ending);
 * - `rules` — the project's own rules in the catalogue's format; an id the catalogue has replaces its rule;
 * - `passScore` — the score a text needs here.
 */
export interface SlopOverrides {
	readonly disable: readonly string[];
	readonly allow: readonly string[];
	readonly rules: readonly SlopRule[];
	readonly passScore?: number;
}

export const NO_SLOP_OVERRIDES: SlopOverrides = { disable: [], allow: [], rules: [] };

/** A project's overrides from `.vibe/slop.json`; a file that does not parse changes nothing and says why. */
export function parseSlopOverrides(text: string, warn: SlopWarn): SlopOverrides {
	const parsed = safeParseConfigJson(text);
	const root = parsed.ok ? objectOf(parsed.value) : undefined;
	if (!root) {
		warn(`slop.json: ${parsed.ok ? 'the root is not an object' : parsed.reason}`);
		return NO_SLOP_OVERRIDES;
	}
	const passScore = numberOf(root.passScore);
	return {
		disable: stringsOf(root.disable).map(id => id.trim()),
		allow: stringsOf(root.allow).map(term => term.trim()),
		rules: slopRulesOf(root.rules, 'slop.json', warn),
		...(passScore !== undefined ? { passScore } : {}),
	};
}

/** The catalogue as this project sees it: a new compiled catalogue, the shared one untouched. */
export function applySlopOverrides(overrides: SlopOverrides, catalog: CompiledSlopCatalog, warn: SlopWarn): CompiledSlopCatalog {
	const off = new Set(overrides.disable.map(id => id.toUpperCase()));
	const own: CompiledSlopRule[] = [];
	for (const rule of overrides.rules) {
		const compiled = compileSlopRule(rule, warn);
		if (compiled) {
			own.push(compiled);
		}
	}
	const ownIds = new Set(own.map(compiled => compiled.rule.id.toUpperCase()));
	const kept = catalog.rules.filter(compiled => !off.has(compiled.rule.id.toUpperCase()) && !ownIds.has(compiled.rule.id.toUpperCase()));
	return {
		scoring: overrides.passScore === undefined ? catalog.scoring : { ...catalog.scoring, passScore: overrides.passScore },
		rules: [...kept, ...own.filter(compiled => !off.has(compiled.rule.id.toUpperCase()))],
		allow: [...catalog.allow, ...slopAllowPatterns(overrides.allow)],
	};
}
