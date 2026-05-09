#!/usr/bin/env node
/**
 * Phase-doc ↔ main-roadmap cross-reference auditor.
 *
 * The repository keeps two tiers of roadmap docs:
 *   - docs/roadmap.md           — canonical, item-level [x]/[~]/[ ] state.
 *   - docs/v1/phases/<phase>/README.md
 *     docs/v1/phases/<phase>/<topic>.md — phase-level acceptance gates &
 *                                    inventory, historically descended from
 *                                    earlier audit work; many items are
 *                                    duplicates of main-roadmap entries.
 *
 * This script reads each phase doc and reports which open `[ ]` items are
 * already covered by a `[x]`/`[~]` entry in the main roadmap (matched by
 * loose substring match on key tokens). Output is intended to surface "phase
 * doc is out of sync with main" so the maintainer can flip the markers.
 *
 * Usage:
 *   node scripts/sync-phase-roadmap.mjs                     # text summary
 *   node scripts/sync-phase-roadmap.mjs --phase 0           # only phase-0
 *   node scripts/sync-phase-roadmap.mjs --json
 *   node scripts/sync-phase-roadmap.mjs --markdown
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MAIN_ROADMAP = path.join(ROOT, 'docs', 'roadmap.md');
const PHASES_DIR = path.join(ROOT, 'docs', 'v1', 'phases');

const ITEM_RE = /^- \[([ x~])\]\s*(.*)$/;
const TOKEN_MIN_LENGTH = 4;
const STOPWORDS = new Set([
	'the', 'and', 'for', 'with', 'into', 'each', 'все', 'для', 'этот', 'если',
	'через', 'будет', 'вместо', 'который', 'который', 'есть', 'была', 'этой',
	'этого', 'явно', 'явный', 'явные', 'либо', 'либо', 'нет', 'или', 'over',
]);

function parseArgs(argv) {
	const args = { phase: undefined, json: false, markdown: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--phase' && argv[i + 1]) { args.phase = argv[++i]; continue; }
		if (a === '--json') { args.json = true; continue; }
		if (a === '--markdown') { args.markdown = true; continue; }
		if (a === '--help' || a === '-h') { args.help = true; continue; }
	}
	return args;
}

function readItems(file) {
	if (!fs.existsSync(file)) { return []; }
	const text = fs.readFileSync(file, 'utf8');
	return text.split(/\r?\n/).flatMap((line, idx) => {
		const m = ITEM_RE.exec(line);
		if (!m) { return []; }
		return [{ file, line: idx + 1, mark: m[1], body: m[2] }];
	});
}

function tokensOf(body) {
	const cleaned = body
		.replace(/`[^`]*`/g, ' ')
		.replace(/\*\*/g, ' ')
		.replace(/[*_~()[\]{}.,;:!?'"]/g, ' ')
		.toLowerCase();
	return new Set(
		cleaned.split(/\s+/).filter(t => t.length >= TOKEN_MIN_LENGTH && !STOPWORDS.has(t))
	);
}

function jaccard(a, b) {
	if (a.size === 0 || b.size === 0) { return 0; }
	let intersect = 0;
	for (const t of a) { if (b.has(t)) { intersect++; } }
	const union = a.size + b.size - intersect;
	return union === 0 ? 0 : intersect / union;
}

function findMatchInMain(phaseItem, mainItems) {
	const phaseTokens = tokensOf(phaseItem.body);
	if (phaseTokens.size < 2) { return null; }
	let best = { score: 0, item: null };
	for (const m of mainItems) {
		if (m.mark === ' ') { continue; }
		const score = jaccard(phaseTokens, tokensOf(m.body));
		if (score > best.score) { best = { score, item: m }; }
	}
	if (best.score >= 0.35) { return best; }
	return null;
}

function listPhaseDocs(phaseFilter) {
	if (!fs.existsSync(PHASES_DIR)) { return []; }
	const out = [];
	for (const ent of fs.readdirSync(PHASES_DIR, { withFileTypes: true })) {
		if (!ent.isDirectory()) { continue; }
		if (!ent.name.startsWith('phase-')) { continue; }
		if (phaseFilter && !ent.name.endsWith(`-${phaseFilter}`)) { continue; }
		const dir = path.join(PHASES_DIR, ent.name);
		for (const file of fs.readdirSync(dir)) {
			if (file.endsWith('.md')) { out.push(path.join(dir, file)); }
		}
	}
	return out;
}

function main() {
	const args = parseArgs(process.argv);
	if (args.help) {
		console.log(`Usage: node scripts/sync-phase-roadmap.mjs [--phase <n>] [--json|--markdown]`);
		return;
	}

	const mainItems = readItems(MAIN_ROADMAP);
	const phaseDocs = listPhaseDocs(args.phase);

	const reports = [];
	for (const doc of phaseDocs) {
		const items = readItems(doc).filter(it => it.mark === ' ');
		const perFile = items.map(it => ({
			line: it.line,
			body: it.body,
			match: findMatchInMain(it, mainItems),
		}));
		reports.push({
			file: path.relative(ROOT, doc).replace(/\\/g, '/'),
			open: perFile.length,
			covered: perFile.filter(p => p.match !== null).length,
			items: perFile,
		});
	}

	if (args.json) {
		console.log(JSON.stringify({ reports }, null, 2));
		return;
	}

	if (args.markdown) {
		const lines = ['# Phase ↔ main-roadmap sync report', ''];
		let totalOpen = 0;
		let totalCovered = 0;
		for (const r of reports) {
			totalOpen += r.open;
			totalCovered += r.covered;
			lines.push(`## \`${r.file}\` — ${r.covered}/${r.open} covered`);
			lines.push('');
			for (const it of r.items) {
				const status = it.match ? `→ main L${it.match.item.line} (score ${it.match.score.toFixed(2)})` : 'NO MATCH';
				const snippet = it.body.replace(/\s+/g, ' ').slice(0, 80);
				lines.push(`- L${it.line}: ${status} — \`${snippet}\``);
			}
			lines.push('');
		}
		lines.unshift('', `**Totals:** ${totalCovered} / ${totalOpen} open phase items have a likely main-roadmap counterpart.`, '');
		console.log(lines.join('\n'));
		return;
	}

	let totalOpen = 0;
	let totalCovered = 0;
	for (const r of reports) {
		totalOpen += r.open;
		totalCovered += r.covered;
		console.log(`${r.covered}/${r.open}  ${r.file}`);
	}
	console.log(`-----`);
	console.log(`${totalCovered}/${totalOpen} open phase items have a likely main-roadmap counterpart.`);
	if (totalOpen === 0) {
		console.log('No open items in phase docs — sync is current.');
	}
}

main();
