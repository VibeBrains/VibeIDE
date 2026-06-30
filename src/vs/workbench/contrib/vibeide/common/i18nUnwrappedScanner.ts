/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * i18n unwrapped-string scanner — pure helper that detects user-facing
 * literals that are NOT wrapped in `nls.localize()` / `nls.localize2()` /
 * `vscode.l10n.t()`. Caller passes raw source; helper returns findings.
 *
 * Closes roadmap §"localize() / localize2() во всех contrib/vibeide/**" group
 * as a tooling helper rather than a one-shot mass rewrite. The scanner is the
 * truth source for "what's left to wrap", driven by CI in warn-only mode and
 * fed to `vibe doctor i18n`.
 *
 * Pure module — `vscode`-free. Caller wires it to file IO + reporters.
 */

export interface UnwrappedFinding {
	readonly line: number;
	readonly column: number;
	readonly snippet: string;
	readonly callsite: 'notify' | 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage' | 'placeholder' | 'title' | 'tooltip' | 'unknown';
}

export interface ScanResult {
	readonly findings: ReadonlyArray<UnwrappedFinding>;
	/** Total user-facing literal call sites visited (wrapped + unwrapped). */
	readonly visitedSites: number;
}

const CALL_PATTERNS: ReadonlyArray<{ regex: RegExp; kind: UnwrappedFinding['callsite'] }> = [
	{ regex: /\bnotificationService\.notify\(\s*\{[^}]*?message:\s*(['"`])([^'"`]+?)\1/g, kind: 'notify' },
	{ regex: /\bshowInformationMessage\(\s*(['"`])([^'"`]+?)\1/g, kind: 'showInformationMessage' },
	{ regex: /\bshowWarningMessage\(\s*(['"`])([^'"`]+?)\1/g, kind: 'showWarningMessage' },
	{ regex: /\bshowErrorMessage\(\s*(['"`])([^'"`]+?)\1/g, kind: 'showErrorMessage' },
	{ regex: /\bplaceHolder:\s*(['"`])([^'"`]+?)\1/g, kind: 'placeholder' },
	{ regex: /\btitle:\s*(['"`])([^'"`]+?)\1/g, kind: 'title' },
	{ regex: /\btooltip:\s*(['"`])([^'"`]+?)\1/g, kind: 'tooltip' },
];

// Proper nouns / product names that legitimately should NOT be localized — they
// are brand identifiers, the same in every locale. Adding a literal here removes
// it from the unwrapped-scan findings without forcing a `localize()` wrap that
// would just round-trip the same string.
//
// Rule of thumb: include only names a user would expect to read verbatim in
// every language (provider brands, vendor names). Do NOT add freeform RU/EN
// labels here — those should be wrapped via `localize()` properly.
export const BRAND_ALLOWLIST: ReadonlySet<string> = new Set([
	'Anthropic',
	'AWS Bedrock',
	'DeepSeek',
	'Gemini',
	'Google Vertex AI',
	'Grok (xAI)',
	'Groq',
	'LiteLLM',
	'LM Router',
	'LM Studio',
	'Microsoft Azure OpenAI',
	'MiniMax',
	'Mistral',
	'Ollama',
	'OpenAI',
	'OpenCode Go',
	'OpenCode Zen',
	'OpenRouter',
	'Pollinations',
	'vLLM',
]);

/**
 * Files with this directive in a top-level comment are skipped entirely.
 * Intended for `vscode`-free pure helpers whose strings are CLI/test labels
 * never rendered through `nls`. Example: `common/standaloneDoctorEnv.ts`.
 */
export const I18N_SCAN_SKIP_DIRECTIVE = '@i18n-scan-skip-file';

/**
 * Scan TypeScript / TSX source for user-facing literal arguments that should
 * be localized but are passed as raw strings (no `localize()` / `l10n.t()` wrap).
 *
 * Heuristics:
 *  - Skip empty strings and one-character punctuation.
 *  - Skip strings that contain only ASCII identifiers + dots (likely IDs / keys).
 *  - Skip if the literal is the second argument of a `localize`/`localize2`/`l10n.t` call.
 *  - Skip the whole file when its header contains `@i18n-scan-skip-file`.
 */
export function scanUnwrappedLiterals(source: string): ScanResult {
	if (typeof source !== 'string' || source.length === 0) {
		return { findings: [], visitedSites: 0 };
	}

	// File-level opt-out: only honor the directive when it appears in the first
	// 2000 characters (header comment region) — keeps inline mentions in code
	// bodies from accidentally disabling the scan.
	if (source.slice(0, 2000).includes(I18N_SCAN_SKIP_DIRECTIVE)) {
		return { findings: [], visitedSites: 0 };
	}

	const lineStarts = computeLineStarts(source);
	const findings: UnwrappedFinding[] = [];
	let visitedSites = 0;

	for (const { regex, kind } of CALL_PATTERNS) {
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(source)) !== null) {
			visitedSites++;
			const literal = match[2];
			if (!isUserFacingLiteral(literal)) {
				continue;
			}
			if (isInsideLocalizeCall(source, match.index)) {
				continue;
			}
			const literalStart = match.index + match[0].lastIndexOf(literal);
			const { line, column } = positionAt(literalStart, lineStarts);
			findings.push({
				line,
				column,
				snippet: trimSnippet(literal),
				callsite: kind,
			});
		}
	}

	findings.sort((a, b) => a.line - b.line || a.column - b.column);
	return { findings, visitedSites };
}

function isUserFacingLiteral(s: string): boolean {
	const trimmed = s.trim();
	if (trimmed.length < 3) { return false; }
	// Pure identifier / dotted key — likely an internal ID.
	if (/^[a-zA-Z0-9_.-]+$/.test(trimmed)) { return false; }
	// URL or path — not localizable.
	if (/^(https?:\/\/|\.{0,2}\/|[a-zA-Z]:[\\/])/.test(trimmed)) { return false; }
	// Brand / product names — same in every locale, not localizable.
	if (BRAND_ALLOWLIST.has(trimmed)) { return false; }
	// Must contain at least one whitespace OR a non-ASCII letter (Cyrillic etc.).
	return /\s/.test(trimmed) || /[^\x00-\x7f]/.test(trimmed);
}

function isInsideLocalizeCall(source: string, literalIndex: number): boolean {
	// Look back up to 200 chars for `localize(` / `localize2(` / `l10n.t(` / `nls.localize`.
	const start = Math.max(0, literalIndex - 200);
	const window = source.slice(start, literalIndex);
	return /\b(localize2?|l10n\.t|nls\.localize)\s*\([^)]*$/.test(window);
}

function computeLineStarts(source: string): number[] {
	const starts: number[] = [0];
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) === 10 /* \n */) {
			starts.push(i + 1);
		}
	}
	return starts;
}

function positionAt(offset: number, lineStarts: ReadonlyArray<number>): { line: number; column: number } {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (lineStarts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
	}
	return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

function trimSnippet(s: string): string {
	const collapsed = s.replace(/\s+/g, ' ').trim();
	return collapsed.length > 80 ? collapsed.slice(0, 77) + '...' : collapsed;
}

export interface ScanSummary {
	readonly totalFiles: number;
	readonly totalFindings: number;
	readonly byCallsite: Readonly<Record<UnwrappedFinding['callsite'], number>>;
}

export function summarize(perFile: ReadonlyArray<{ filePath: string; result: ScanResult }>): ScanSummary {
	const byCallsite: Record<UnwrappedFinding['callsite'], number> = {
		notify: 0,
		showInformationMessage: 0,
		showWarningMessage: 0,
		showErrorMessage: 0,
		placeholder: 0,
		title: 0,
		tooltip: 0,
		unknown: 0,
	};
	let totalFindings = 0;
	for (const { result } of perFile) {
		for (const f of result.findings) {
			byCallsite[f.callsite]++;
			totalFindings++;
		}
	}
	return {
		totalFiles: perFile.length,
		totalFindings,
		byCallsite,
	};
}

/** Markdown report for CI sticky comment / vibe doctor i18n section. */
export function renderScanMarkdown(summary: ScanSummary, perFile: ReadonlyArray<{ filePath: string; result: ScanResult }>): string {
	const lines: string[] = [];
	lines.push('# i18n unwrapped-strings scan');
	lines.push('');
	lines.push(`**Files scanned:** ${summary.totalFiles}`);
	lines.push(`**Total findings:** ${summary.totalFindings}`);
	lines.push('');
	lines.push('| Call site | Count |');
	lines.push('|---|---:|');
	for (const [k, v] of Object.entries(summary.byCallsite)) {
		if (v > 0) { lines.push(`| ${k} | ${v} |`); }
	}
	lines.push('');
	if (summary.totalFindings === 0) {
		lines.push('No unwrapped user-facing literals detected.');
		return lines.join('\n') + '\n';
	}
	lines.push('## Findings');
	lines.push('');
	const sortedFiles = [...perFile]
		.filter(p => p.result.findings.length > 0)
		.sort((a, b) => b.result.findings.length - a.result.findings.length);
	for (const { filePath, result } of sortedFiles) {
		lines.push(`### \`${filePath}\` — ${result.findings.length}`);
		lines.push('');
		for (const f of result.findings) {
			lines.push(`- L${f.line}:${f.column} (${f.callsite}) — \`${f.snippet}\``);
		}
		lines.push('');
	}
	return lines.join('\n');
}
