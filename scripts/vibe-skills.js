#!/usr/bin/env node
/**
 * vibe skills — CLI for Agent Skills (SKILL.md) validation and listing.
 *
 * Usage:
 *   node scripts/vibe-skills.js validate
 *   node scripts/vibe-skills.js list [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

function readProductDefaultLocale() {
	try {
		const pj = path.join(process.cwd(), 'product.json');
		const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
		const dl = j.defaultLocale;
		return typeof dl === 'string' ? dl : 'en';
	} catch {
		return 'en';
	}
}

/** @param {string} base Basename only */
function parseSkillPrimaryFilename(base) {
	const m = /^skill(?:\.([a-z0-9-]+))?\.md$/i.exec(base);
	if (!m) {
		return null;
	}
	if (!m[1]) {
		return { type: 'base' };
	}
	return { type: 'localized', locale: m[1].toLowerCase() };
}

function effectiveSkillLocales() {
	const raw = readProductDefaultLocale().trim().toLowerCase().replace(/_/g, '-');
	if (!raw) {
		return ['en'];
	}
	const primary = raw.split('-')[0] || 'en';
	const ordered = raw !== primary ? [raw, primary] : [primary];
	return [...new Set(ordered)];
}

/** Prefer SKILL.<locale>.md matching defaultLocale chain, then SKILL.md (same as vibeSkillsLibraryService). */
function pickPrimaryNamedSkillPath(pathsInDir) {
	const primaries = pathsInDir.filter(p => parseSkillPrimaryFilename(path.basename(p)));
	if (!primaries.length) {
		return undefined;
	}
	for (const loc of effectiveSkillLocales()) {
		const hit = primaries.find(p => {
			const t = parseSkillPrimaryFilename(path.basename(p));
			return t?.type === 'localized' && t.locale === loc;
		});
		if (hit) {
			return hit;
		}
	}
	const baseHit = primaries.find(p => parseSkillPrimaryFilename(path.basename(p))?.type === 'base');
	return baseHit ?? primaries[0];
}

/**
 * Paths that participate in duplicate-id / depends graph (mirrors workspace loader folder rules).
 * @param {string[]} allPaths
 */
function canonicalSkillMarkdownPaths(allPaths) {
	/** @type {Map<string, string[]>} */
	const byDir = new Map();
	for (const abs of allPaths) {
		const d = path.dirname(abs);
		if (!byDir.has(d)) {
			byDir.set(d, []);
		}
		byDir.get(d).push(abs);
	}
	const out = [];
	for (const pathsInDir of byDir.values()) {
		const primary = pickPrimaryNamedSkillPath(pathsInDir);
		const consumed = new Set();
		if (primary) {
			out.push(primary);
			consumed.add(primary);
		}
		for (const p of pathsInDir) {
			if (consumed.has(p)) {
				continue;
			}
			const bn = path.basename(p);
			if (parseSkillPrimaryFilename(bn)) {
				continue;
			}
			if (!bn.toLowerCase().endsWith('skill.md')) {
				continue;
			}
			out.push(p);
		}
	}
	return out;
}

function walkSkillMarkdownFiles(rootDir, acc = []) {
	if (!fs.existsSync(rootDir)) {
		return acc;
	}
	for (const ent of fs.readdirSync(rootDir, { withFileTypes: true })) {
		const p = path.join(rootDir, ent.name);
		if (ent.isDirectory()) {
			walkSkillMarkdownFiles(p, acc);
		} else if (parseSkillPrimaryFilename(ent.name) || ent.name.toLowerCase().endsWith('.skill.md')) {
			acc.push(p);
		}
	}
	return acc;
}

function parseSkillFrontmatter(filePath, raw) {
	const rel = path.relative(process.cwd(), filePath);
	const fm = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
	if (!fm) {
		return { rel, ok: false, errors: ['missing YAML frontmatter (--- ... ---)'] };
	}
	const block = fm[1];
	const errors = [];
	const name = block.match(/^\s*name:\s*(.+)\s*$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '');
	const description = block.match(/^\s*description:\s*(.+)\s*$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '');
	const vv = block.match(/^\s*vibeVersion:\s*["']?([^"'\n]+)["']?\s*$/im)?.[1]?.trim();
	const precheckRaw = block.match(/^\s*precheck:\s*(.+)\s*$/im)?.[1]?.trim()?.replace(/^["']|["']$/g, '') ?? '';

	const depends = parseDependsBlock(block);

	if (!name) errors.push('missing name');
	if (!description) errors.push('missing description');
	if (!vv) errors.push('missing vibeVersion');

	const maxBytes = 512 * 1024;
	let size = 0;
	try {
		size = fs.statSync(filePath).size;
	} catch { /* ignore */ }
	if (size > maxBytes) {
		errors.push(`file exceeds ${maxBytes} bytes`);
	}

	const forbid = /\.\.(?:\/|\\)/;
	if (forbid.test(rel)) {
		errors.push('path traversal segment not allowed');
	}

	const precheck = precheckRaw ? precheckRaw : null;

	return {
		rel,
		ok: errors.length === 0,
		errors,
		skillId: name || path.basename(path.dirname(filePath)),
		description: description || '',
		vibeVersion: vv || null,
		size,
		depends,
		precheck,
	};
}

/** @param {string} block YAML frontmatter body (between ---) */
function parseDependsBlock(block) {
	const lines = block.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const inline = /^\s*depends:\s*\[(.*)]\s*$/.exec(line);
		if (inline) {
			const inner = inline[1].trim();
			if (!inner) return [];
			return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
		}
		if (/^\s*depends:\s*$/.test(line)) {
			const items = [];
			let j = i + 1;
			while (j < lines.length) {
				const l = lines[j];
				if (/^\s*-\s+/.test(l)) {
					items.push(l.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
					j++;
					continue;
				}
				if (l.trim() === '') {
					j++;
					continue;
				}
				break;
			}
			return items.filter(Boolean);
		}
	}
	return [];
}

/** @param {{ skillId: string, depends: string[], rel: string }[]} skillInfos */
function hasDependsCycle(skillInfos) {
	const graph = new Map();
	for (const s of skillInfos) {
		graph.set(s.skillId.toLowerCase(), (s.depends || []).map(d => d.trim().toLowerCase()));
	}
	/** @type {Map<string, number>} */
	const state = new Map();

	function dfs(u) {
		const st = state.get(u) ?? 0;
		if (st === 1) return true;
		if (st === 2) return false;
		state.set(u, 1);
		for (const v of graph.get(u) || []) {
			if (!graph.has(v)) continue;
			if (dfs(v)) return true;
		}
		state.set(u, 2);
		return false;
	}

	for (const id of graph.keys()) {
		if ((state.get(id) ?? 0) === 0 && dfs(id)) {
			return true;
		}
	}
	return false;
}

/** @param {string | null} [precheckOpt] */
function validateSkillBundle(skillMdAbs, precheckOpt) {
	const errors = [];
	const warnings = [];
	const dir = path.dirname(skillMdAbs);
	const skillsRoot = path.join(process.cwd(), '.vibe', 'skills');
	const ref = path.join(dir, 'reference.md');
	if (fs.existsSync(ref)) {
		let realRef;
		let realRoot;
		try {
			realRef = fs.realpathSync.native ? fs.realpathSync.native(ref) : fs.realpathSync(ref);
			realRoot = fs.realpathSync.native ? fs.realpathSync.native(skillsRoot) : fs.realpathSync(skillsRoot);
		} catch {
			realRef = path.resolve(ref);
			realRoot = path.resolve(skillsRoot);
		}
		const relToRoot = path.relative(realRoot, realRef);
		if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
			errors.push('reference.md resolves outside .vibe/skills');
		}
	}
	const scriptsDir = path.join(dir, 'scripts');
	if (fs.existsSync(scriptsDir) && fs.statSync(scriptsDir).isDirectory()) {
		warnings.push('scripts/ directory present — execution requires sandbox/trust policy (see roadmap)');
	}

	if (precheckOpt && String(precheckOpt).trim()) {
		const pc = String(precheckOpt).trim();
		if (pc.includes('..') || path.isAbsolute(pc)) {
			errors.push('precheck must be a relative path without parent segments');
		} else {
			const resolved = path.resolve(dir, pc);
			const safeRoot = path.resolve(dir);
			const relSafe = path.relative(safeRoot, resolved);
			if (relSafe.startsWith('..') || path.isAbsolute(relSafe)) {
				errors.push('precheck escapes skill directory');
			} else if (!fs.existsSync(resolved)) {
				warnings.push(`precheck path not found: ${pc}`);
			}
		}
	}

	return { errors, warnings };
}

function validate() {
	const roots = [path.join(process.cwd(), '.vibe', 'skills')];
	const files = roots.flatMap(r => walkSkillMarkdownFiles(r, []));
	if (!files.length) {
		console.log('[validate] no SKILL.md under .vibe/skills');
		process.exit(0);
	}
	const canonicalSet = new Set(canonicalSkillMarkdownPaths(files));
	const byId = new Map();
	/** @type {{ skillId: string, depends: string[], rel: string }[]} */
	const depGraph = [];
	let exit = 0;
	for (const f of files) {
		const raw = fs.readFileSync(f, 'utf-8');
		const p = parseSkillFrontmatter(f, raw);
		if (!p.ok) {
			console.error(`❌ ${p.rel}: ${p.errors.join('; ')}`);
			exit = 1;
			continue;
		}
		const bundle = validateSkillBundle(f, p.precheck);
		for (const w of bundle.warnings) {
			console.warn(`⚠️  ${p.rel}: ${w}`);
		}
		if (bundle.errors.length) {
			console.error(`❌ ${p.rel}: ${bundle.errors.join('; ')}`);
			exit = 1;
			continue;
		}
		if (!canonicalSet.has(f)) {
			console.log(`✅ ${p.rel} (${p.skillId}, vibeVersion ${p.vibeVersion}) [locale sibling — not canonical id]`);
			continue;
		}
		const key = p.skillId.toLowerCase();
		if (byId.has(key)) {
			console.error(`❌ duplicate skill id "${p.skillId}": ${p.rel} vs ${byId.get(key)}`);
			exit = 1;
			continue;
		}
		byId.set(key, p.rel);
		depGraph.push({ skillId: p.skillId, depends: p.depends || [], rel: p.rel });
		console.log(`✅ ${p.rel} (${p.skillId}, vibeVersion ${p.vibeVersion})`);
	}
	const idSet = new Set(depGraph.map(s => s.skillId.toLowerCase()));
	for (const s of depGraph) {
		for (const d of s.depends) {
			if (!idSet.has(d.toLowerCase())) {
				console.error(`❌ ${s.rel}: unknown depends "${d}"`);
				exit = 1;
			}
		}
	}
	if (depGraph.length && hasDependsCycle(depGraph)) {
		console.error('❌ cyclic depends: skill pack DAG must be acyclic');
		exit = 1;
	}
	process.exit(exit);
}

function listCmd() {
	const json = args.includes('--json');
	const roots = [path.join(process.cwd(), '.vibe', 'skills')];
	const files = roots.flatMap(r => walkSkillMarkdownFiles(r, []));
	const canonical = canonicalSkillMarkdownPaths(files);
	const skills = [];
	for (const f of canonical) {
		const raw = fs.readFileSync(f, 'utf-8');
		const p = parseSkillFrontmatter(f, raw);
		skills.push({
			path: p.rel,
			skillId: p.skillId,
			description: p.description.slice(0, 4096),
			vibeVersion: p.vibeVersion,
			depends: p.depends || [],
			precheck: p.precheck,
			valid: p.ok,
			errors: p.errors,
		});
	}
	skills.sort((a, b) => a.skillId.localeCompare(b.skillId));
	if (json) {
		console.log(JSON.stringify({ skills, cwd: process.cwd() }, null, '\t'));
		return;
	}
	for (const s of skills) {
		console.log(`${s.skillId}\t${s.valid ? 'ok' : 'invalid'}\t${s.path}`);
	}
}

const cmd = args.find(a => !a.startsWith('-')) || 'help';
if (cmd === 'validate') {
	validate();
} else if (cmd === 'list') {
	listCmd();
} else {
	console.log(`Usage:
  node scripts/vibe-skills.js validate
  node scripts/vibe-skills.js list [--json]`);
	process.exit(cmd === 'help' ? 0 : 1);
}
