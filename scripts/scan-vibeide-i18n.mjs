#!/usr/bin/env node
/**
 * Standalone runner for the i18n unwrapped-strings scan.
 *
 * Source-of-truth helper:
 *   src/vs/workbench/contrib/vibeide/common/i18nUnwrappedScanner.ts
 *
 * This .mjs duplicates the scanner regex set so it runs without a TS compile
 * step (CI startup time matters for warn-only checks). Both must stay in sync;
 * the scanner's unit tests are the canonical regression coverage.
 *
 * Usage:
 *   node scripts/scan-vibeide-i18n.mjs                 # text report
 *   node scripts/scan-vibeide-i18n.mjs --json
 *   node scripts/scan-vibeide-i18n.mjs --markdown
 *   node scripts/scan-vibeide-i18n.mjs --root <path>   # default: src/vs/workbench/contrib/vibeide
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEFAULT_SCAN_ROOT = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide');

const CALL_PATTERNS = [
	{ regex: /\bnotificationService\.notify\(\s*\{[^}]*?message:\s*(['"`])([^'"`]+?)\1/g, kind: 'notify' },
	{ regex: /\bshowInformationMessage\(\s*(['"`])([^'"`]+?)\1/g, kind: 'showInformationMessage' },
	{ regex: /\bshowWarningMessage\(\s*(['"`])([^'"`]+?)\1/g, kind: 'showWarningMessage' },
	{ regex: /\bshowErrorMessage\(\s*(['"`])([^'"`]+?)\1/g, kind: 'showErrorMessage' },
	{ regex: /\bplaceHolder:\s*(['"`])([^'"`]+?)\1/g, kind: 'placeholder' },
	{ regex: /\btitle:\s*(['"`])([^'"`]+?)\1/g, kind: 'title' },
	{ regex: /\btooltip:\s*(['"`])([^'"`]+?)\1/g, kind: 'tooltip' },
];

// MUST stay in sync with BRAND_ALLOWLIST in src/vs/workbench/contrib/vibeide/common/i18nUnwrappedScanner.ts
const BRAND_ALLOWLIST = new Set([
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
	'Mistral',
	'Ollama',
	'OpenAI',
	'OpenCode Go',
	'OpenCode Zen',
	'OpenRouter',
	'Pollinations',
	'vLLM',
]);

function isUserFacingLiteral(s) {
	const trimmed = s.trim();
	if (trimmed.length < 3) { return false; }
	if (/^[a-zA-Z0-9_.-]+$/.test(trimmed)) { return false; }
	if (/^(https?:\/\/|\.{0,2}\/|[a-zA-Z]:[\\/])/.test(trimmed)) { return false; }
	if (BRAND_ALLOWLIST.has(trimmed)) { return false; }
	return /\s/.test(trimmed) || /[^\x00-\x7f]/.test(trimmed);
}

function isInsideLocalizeCall(source, literalIndex) {
	const start = Math.max(0, literalIndex - 200);
	const window = source.slice(start, literalIndex);
	return /\b(localize2?|l10n\.t|nls\.localize)\s*\([^)]*$/.test(window);
}

function computeLineStarts(source) {
	const starts = [0];
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) === 10) { starts.push(i + 1); }
	}
	return starts;
}

function positionAt(offset, lineStarts) {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (lineStarts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
	}
	return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

function trimSnippet(s) {
	const collapsed = s.replace(/\s+/g, ' ').trim();
	return collapsed.length > 80 ? collapsed.slice(0, 77) + '...' : collapsed;
}

// MUST stay in sync with I18N_SCAN_SKIP_DIRECTIVE in i18nUnwrappedScanner.ts.
const I18N_SCAN_SKIP_DIRECTIVE = '@i18n-scan-skip-file';

function scanUnwrappedLiterals(source) {
	if (typeof source !== 'string' || source.length === 0) {
		return { findings: [], visitedSites: 0 };
	}
	// File-level opt-out: honor directive only in the first 2000 chars (header).
	if (source.slice(0, 2000).includes(I18N_SCAN_SKIP_DIRECTIVE)) {
		return { findings: [], visitedSites: 0 };
	}
	const lineStarts = computeLineStarts(source);
	const findings = [];
	let visitedSites = 0;

	for (const { regex, kind } of CALL_PATTERNS) {
		regex.lastIndex = 0;
		let match;
		while ((match = regex.exec(source)) !== null) {
			visitedSites++;
			const literal = match[2];
			if (!isUserFacingLiteral(literal)) { continue; }
			if (isInsideLocalizeCall(source, match.index)) { continue; }
			const literalStart = match.index + match[0].lastIndexOf(literal);
			const { line, column } = positionAt(literalStart, lineStarts);
			findings.push({ line, column, snippet: trimSnippet(literal), callsite: kind });
		}
	}
	findings.sort((a, b) => a.line - b.line || a.column - b.column);
	return { findings, visitedSites };
}

function walkSources(root) {
	const out = [];
	if (!fs.existsSync(root)) { return out; }
	for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
		const p = path.join(root, ent.name);
		if (ent.isDirectory()) {
			// Skip generated React out, node_modules, test fixtures.
			if (ent.name === 'react' || ent.name === 'node_modules' || ent.name === 'out') { continue; }
			out.push(...walkSources(p));
			continue;
		}
		if (!/\.(ts|tsx)$/.test(ent.name)) { continue; }
		if (/\.test\.tsx?$/.test(ent.name) || /\.fixture\.tsx?$/.test(ent.name)) { continue; }
		out.push(p);
	}
	return out;
}

function parseArgs(argv) {
	const args = { json: false, markdown: false, root: DEFAULT_SCAN_ROOT };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--json') { args.json = true; continue; }
		if (a === '--markdown') { args.markdown = true; continue; }
		if (a === '--root' && argv[i + 1]) { args.root = path.resolve(argv[++i]); continue; }
		if (a === '--help') { args.help = true; continue; }
	}
	return args;
}

function summarize(perFile) {
	const byCallsite = {
		notify: 0, showInformationMessage: 0, showWarningMessage: 0,
		showErrorMessage: 0, placeholder: 0, title: 0, tooltip: 0, unknown: 0,
	};
	let totalFindings = 0;
	for (const { result } of perFile) {
		for (const f of result.findings) {
			byCallsite[f.callsite]++;
			totalFindings++;
		}
	}
	return { totalFiles: perFile.length, totalFindings, byCallsite };
}

function renderMarkdown(summary, perFile) {
	const lines = [];
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

function main() {
	const args = parseArgs(process.argv);
	if (args.help) {
		console.log(`Usage: node scripts/scan-vibeide-i18n.mjs [--json|--markdown] [--root <path>]`);
		return;
	}

	const files = walkSources(args.root);
	const perFile = files.map(filePath => {
		const source = fs.readFileSync(filePath, 'utf8');
		return { filePath: path.relative(ROOT, filePath).replace(/\\/g, '/'), result: scanUnwrappedLiterals(source) };
	});
	const summary = summarize(perFile);

	if (args.json) {
		console.log(JSON.stringify({ summary, perFile }, null, 2));
		return;
	}
	if (args.markdown) {
		console.log(renderMarkdown(summary, perFile));
		return;
	}

	console.log(`[scan-vibeide-i18n] root: ${path.relative(ROOT, args.root) || '.'}`);
	console.log(`  files scanned: ${summary.totalFiles}`);
	console.log(`  findings:      ${summary.totalFindings}`);
	for (const [k, v] of Object.entries(summary.byCallsite)) {
		if (v > 0) { console.log(`    ${k}: ${v}`); }
	}
	if (summary.totalFindings === 0) {
		console.log('OK: no unwrapped user-facing literals detected.');
	} else {
		console.log('Use --markdown for a per-file breakdown or --json for tooling.');
	}
}

main();
