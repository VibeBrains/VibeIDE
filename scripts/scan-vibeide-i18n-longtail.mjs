#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Long-tail i18n scanner extending the call-pattern set beyond
 * scripts/scan-vibeide-i18n.mjs. Detects user-facing literals in
 * additional call sites: label/description/category/name/text/prompt/detail.
 * Filters by scope (browser/vibe*Contribution|StatusBar*, electron-main, common).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SCOPE_GLOBS = [
	/^src\/vs\/workbench\/contrib\/vibeide\/browser\/vibe[A-Za-z0-9_]*Contribution\.ts$/,
	/^src\/vs\/workbench\/contrib\/vibeide\/browser\/vibe[A-Za-z0-9_]*StatusBar[A-Za-z0-9_]*\.ts$/,
	/^src\/vs\/workbench\/contrib\/vibeide\/electron-main\//,
	/^src\/vs\/workbench\/contrib\/vibeide\/common\//,
];

const PATTERNS = [
	{ regex: /\bnotificationService\.notify\(\s*\{[^}]*?message:\s*(['"`])([^'"`]+?)\1/g, kind: 'notify' },
	{ regex: /\bshowInformationMessage\(\s*(['"`])([^'"`]+?)\1/g, kind: 'showInformationMessage' },
	{ regex: /\bshowWarningMessage\(\s*(['"`])([^'"`]+?)\1/g, kind: 'showWarningMessage' },
	{ regex: /\bshowErrorMessage\(\s*(['"`])([^'"`]+?)\1/g, kind: 'showErrorMessage' },
	{ regex: /\bplaceHolder:\s*(['"`])([^'"`]+?)\1/g, kind: 'placeholder' },
	{ regex: /\btitle:\s*(['"`])([^'"`]+?)\1/g, kind: 'title' },
	{ regex: /\btooltip:\s*(['"`])([^'"`]+?)\1/g, kind: 'tooltip' },
	{ regex: /\blabel:\s*(['"`])([^'"`]+?)\1/g, kind: 'label' },
	{ regex: /\bdescription:\s*(['"`])([^'"`]+?)\1/g, kind: 'description' },
	{ regex: /\bcategory:\s*(['"`])([^'"`]+?)\1/g, kind: 'category' },
	{ regex: /\bname:\s*(['"`])([^'"`]+?)\1/g, kind: 'name' },
	{ regex: /\btext:\s*(['"`])([^'"`]+?)\1/g, kind: 'text' },
	{ regex: /\bprompt:\s*(['"`])([^'"`]+?)\1/g, kind: 'prompt' },
	{ regex: /\bdetail:\s*(['"`])([^'"`]+?)\1/g, kind: 'detail' },
	{ regex: /\bask\(\s*(['"`])([^'"`]+?)\1/g, kind: 'ask_call' },
	{ regex: /\bask2\(\s*(['"`])([^'"`]+?)\1/g, kind: 'ask2_call' },
];

const BRAND_ALLOWLIST = new Set([
	'Anthropic','AWS Bedrock','DeepSeek','Gemini','Google Vertex AI','Grok (xAI)','Groq',
	'LiteLLM','LM Router','LM Studio','Microsoft Azure OpenAI','Mistral','Ollama','OpenAI',
	'OpenCode Go','OpenCode Zen','OpenRouter','Pollinations','vLLM',
	'VibeIDE','VS Code','Visual Studio Code','GitHub','Git','npm','Node.js','TypeScript',
	'JavaScript','Python','Markdown','JSON','YAML','TOML','HTML','CSS','SCSS',
	'MCP','LLM','API','SCM','PR','UI','URL','UUID','VSCode',
]);

const I18N_SCAN_SKIP_DIRECTIVE = '@i18n-scan-skip-file';

function isUserFacingLiteral(s) {
	const trimmed = s.trim();
	if (trimmed.length < 3) { return false; }
	if (/^[a-zA-Z0-9_.\-]+$/.test(trimmed)) { return false; }
	if (/^(https?:\/\/|\.{0,2}\/|[a-zA-Z]:[\\/])/.test(trimmed)) { return false; }
	if (BRAND_ALLOWLIST.has(trimmed)) { return false; }
	if (/^[a-z][\w.\-]*\.[\w.\-]+$/.test(trimmed)) { return false; }
	if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|FROM|WHERE)\b/i.test(trimmed) && !/[А-Яа-я]/.test(trimmed)) { return false; }
	if (!/\s/.test(trimmed) && !/[^\x00-\x7f]/.test(trimmed) && trimmed.length < 14) { return false; }
	return /\s/.test(trimmed) || /[^\x00-\x7f]/.test(trimmed) || trimmed.length >= 14;
}

function isInsideLocalizeCall(source, idx) {
	const start = Math.max(0, idx - 300);
	const win = source.slice(start, idx);
	return /\b(localize2?|l10n\.t|nls\.localize)\s*\([^)]*$/.test(win);
}

function computeLineStarts(source) {
	const starts = [0];
	for (let i = 0; i < source.length; i++) { if (source.charCodeAt(i) === 10) { starts.push(i + 1); } }
	return starts;
}
function positionAt(offset, ls) {
	let lo = 0, hi = ls.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (ls[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
	}
	return { line: lo + 1, column: offset - ls[lo] + 1 };
}
function trim(s) { const c = s.replace(/\s+/g, ' ').trim(); return c.length > 80 ? c.slice(0,77)+'...' : c; }

function scan(source) {
	if (source.slice(0, 2000).includes(I18N_SCAN_SKIP_DIRECTIVE)) { return []; }
	const ls = computeLineStarts(source);
	const out = [];
	for (const { regex, kind } of PATTERNS) {
		regex.lastIndex = 0;
		let m;
		while ((m = regex.exec(source)) !== null) {
			const lit = m[2];
			if (!isUserFacingLiteral(lit)) { continue; }
			if (isInsideLocalizeCall(source, m.index)) { continue; }
			const start = m.index + m[0].lastIndexOf(lit);
			const { line, column } = positionAt(start, ls);
			out.push({ line, column, snippet: trim(lit), callsite: kind });
		}
	}
	const seen = new Set();
	return out
		.filter(f => { const k = f.line + ':' + f.column; if (seen.has(k)) { return false; } seen.add(k); return true; })
		.sort((a,b) => a.line - b.line || a.column - b.column);
}

function walk(root, out=[]) {
	if (!fs.existsSync(root)) { return out; }
	for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
		const p = path.join(root, ent.name);
		if (ent.isDirectory()) {
			if (['react','node_modules','out'].includes(ent.name)) { continue; }
			walk(p, out);
			continue;
		}
		if (!/\.(ts|tsx)$/.test(ent.name)) { continue; }
		if (/\.test\.tsx?$/.test(ent.name) || /\.fixture\.tsx?$/.test(ent.name)) { continue; }
		out.push(p);
	}
	return out;
}

function inScope(rel) {
	return SCOPE_GLOBS.some(re => re.test(rel));
}

function main() {
	const base = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide');
	const files = walk(base);
	const perFile = [];
	for (const f of files) {
		const rel = path.relative(ROOT, f).replace(/\\/g,'/');
		if (!inScope(rel)) { continue; }
		const src = fs.readFileSync(f, 'utf8');
		const findings = scan(src);
		if (findings.length) { perFile.push({ filePath: rel, findings }); }
	}
	const total = perFile.reduce((a,b) => a + b.findings.length, 0);
	console.log('Files in scope with findings: ' + perFile.length);
	console.log('Total findings: ' + total);
	if (process.argv.includes('--json')) {
		console.log(JSON.stringify(perFile, null, 2));
		return;
	}
	perFile.sort((a,b) => b.findings.length - a.findings.length);
	for (const { filePath, findings } of perFile) {
		console.log('\n### ' + filePath + ' — ' + findings.length);
		for (const f of findings) { console.log('  L' + f.line + ':' + f.column + ' (' + f.callsite + ') — ' + f.snippet); }
	}
}
main();
