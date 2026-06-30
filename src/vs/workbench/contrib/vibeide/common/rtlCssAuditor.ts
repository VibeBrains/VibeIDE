/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * RTL-preparation CSS auditor — pure linter
 * (roadmap §"i18n improvements — RTL-preparation: пройтись по
 * sidebar/chat/diff CSS, заменить hard-coded `padding-left/right` на
 * `padding-inline-start/end`; smoke-тест с `--locale ar` (даже без ar-bundle
 * — UI должен зеркалиться)").
 *
 * Pure helper — `vscode`-free. Caller passes already-loaded CSS file
 * contents; auditor reports each `padding-left|right`, `margin-left|right`,
 * `border-left|right`, `text-align: left|right`, `float: left|right`
 * occurrence with line + column. Suggests the logical-property replacement.
 */

interface AuditorRule {
	readonly find: RegExp;
	readonly suggest: (match: string) => string;
	readonly category: AuditCategory;
}

export type AuditCategory =
	| 'padding-physical'
	| 'margin-physical'
	| 'border-physical'
	| 'text-align-physical'
	| 'float-physical'
	| 'left-right-position';

export interface RtlAuditFinding {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly category: AuditCategory;
	readonly snippet: string;
	readonly suggestion: string;
}

const RULES: ReadonlyArray<AuditorRule> = [
	{
		find: /\bpadding-left\b/g,
		suggest: () => 'padding-inline-start',
		category: 'padding-physical',
	},
	{
		find: /\bpadding-right\b/g,
		suggest: () => 'padding-inline-end',
		category: 'padding-physical',
	},
	{
		find: /\bmargin-left\b/g,
		suggest: () => 'margin-inline-start',
		category: 'margin-physical',
	},
	{
		find: /\bmargin-right\b/g,
		suggest: () => 'margin-inline-end',
		category: 'margin-physical',
	},
	{
		find: /\bborder-left\b/g,
		suggest: () => 'border-inline-start',
		category: 'border-physical',
	},
	{
		find: /\bborder-right\b/g,
		suggest: () => 'border-inline-end',
		category: 'border-physical',
	},
	{
		find: /text-align\s*:\s*left\b/g,
		suggest: () => 'text-align: start',
		category: 'text-align-physical',
	},
	{
		find: /text-align\s*:\s*right\b/g,
		suggest: () => 'text-align: end',
		category: 'text-align-physical',
	},
	{
		find: /float\s*:\s*left\b/g,
		suggest: () => 'float: inline-start',
		category: 'float-physical',
	},
	{
		find: /float\s*:\s*right\b/g,
		suggest: () => 'float: inline-end',
		category: 'float-physical',
	},
];

const RULES_LEFT_RIGHT_POS: AuditorRule = {
	find: /^\s*(left|right)\s*:/gm,
	suggest: (m) => m.includes('left') ? 'inset-inline-start: …' : 'inset-inline-end: …',
	category: 'left-right-position',
};

const COMMENT_BLOCK = /\/\*[\s\S]*?\*\//g;
const COMMENT_LINE = /\/\/[^\n]*/g;

/**
 * Audit a CSS file for physical-direction properties. Pure.
 *
 * Comments are stripped before scanning so a documented `padding-left` in
 * a comment doesn't trigger a false positive.
 *
 * Findings are returned sorted by `(line, column)` for deterministic
 * snapshot tests.
 */
export function auditCssForRtl(filePath: string, content: string): readonly RtlAuditFinding[] {
	if (typeof content !== 'string' || content.length === 0) { return []; }
	const stripped = content.replace(COMMENT_BLOCK, m => ' '.repeat(m.length)).replace(COMMENT_LINE, m => ' '.repeat(m.length));

	const findings: RtlAuditFinding[] = [];
	for (const rule of RULES) {
		const re = new RegExp(rule.find.source, rule.find.flags);
		let m: RegExpExecArray | null;
		while ((m = re.exec(stripped)) !== null) {
			const { line, column } = locationOf(stripped, m.index);
			findings.push({
				file: filePath,
				line,
				column,
				category: rule.category,
				snippet: m[0],
				suggestion: rule.suggest(m[0]),
			});
		}
	}
	// Special-case: position `left:` / `right:` literals at line start —
	// these are far more likely to be positioning than the colour `linear-gradient(left, ...)`.
	{
		const re = new RegExp(RULES_LEFT_RIGHT_POS.find.source, RULES_LEFT_RIGHT_POS.find.flags);
		let m: RegExpExecArray | null;
		while ((m = re.exec(stripped)) !== null) {
			const { line, column } = locationOf(stripped, m.index);
			findings.push({
				file: filePath,
				line,
				column,
				category: RULES_LEFT_RIGHT_POS.category,
				snippet: m[0].trim(),
				suggestion: RULES_LEFT_RIGHT_POS.suggest(m[0]),
			});
		}
	}

	findings.sort((a, b) => {
		if (a.line !== b.line) { return a.line - b.line; }
		return a.column - b.column;
	});
	return findings;
}

function locationOf(content: string, offset: number): { line: number; column: number } {
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < offset; i++) {
		if (content[i] === '\n') {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, column: offset - lineStart + 1 };
}

/**
 * Aggregate findings from multiple files. Pure.
 */
export function summariseRtlAudit(
	findings: ReadonlyArray<RtlAuditFinding>,
): {
	readonly total: number;
	readonly byCategory: Readonly<Record<AuditCategory, number>>;
	readonly byFile: Readonly<Record<string, number>>;
	readonly worstFile: string | null;
} {
	const byCategory: Record<AuditCategory, number> = {
		'padding-physical': 0,
		'margin-physical': 0,
		'border-physical': 0,
		'text-align-physical': 0,
		'float-physical': 0,
		'left-right-position': 0,
	};
	const byFile: Record<string, number> = {};
	for (const f of findings) {
		byCategory[f.category]++;
		byFile[f.file] = (byFile[f.file] ?? 0) + 1;
	}
	let worstFile: string | null = null;
	let max = 0;
	for (const [file, count] of Object.entries(byFile)) {
		if (count > max) {
			max = count;
			worstFile = file;
		}
	}
	return { total: findings.length, byCategory, byFile, worstFile };
}

/**
 * Render a markdown report for the audit. Pure formatter.
 */
export function renderRtlAuditMarkdown(
	findings: ReadonlyArray<RtlAuditFinding>,
	maxFindings = 50,
): string {
	const summary = summariseRtlAudit(findings);
	const lines: string[] = [];
	lines.push('# RTL CSS audit');
	lines.push('');
	lines.push(`**Total findings:** ${summary.total}`);
	if (summary.worstFile !== null) {
		lines.push(`**Worst file:** \`${summary.worstFile}\` (${summary.byFile[summary.worstFile]} findings)`);
	}
	lines.push('');
	lines.push('## By category');
	for (const [cat, n] of Object.entries(summary.byCategory)) {
		if (n > 0) { lines.push(`- ${cat}: ${n}`); }
	}
	if (findings.length === 0) {
		lines.push('');
		lines.push('✅ No physical-direction properties found.');
		return lines.join('\n');
	}
	lines.push('');
	lines.push('## Top findings');
	for (const f of findings.slice(0, maxFindings)) {
		lines.push(`- \`${f.file}:${f.line}:${f.column}\` — \`${f.snippet}\` → \`${f.suggestion}\``);
	}
	if (findings.length > maxFindings) {
		lines.push(`- …and ${findings.length - maxFindings} more`);
	}
	return lines.join('\n');
}
