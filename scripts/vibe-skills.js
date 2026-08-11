#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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

// Ограничения формата Agent Skills (agentskills/agentskills, docs/specification.mdx).
// Держим их одним местом, чтобы при обновлении спеки правилась одна строка, а не пять проверок.
const SPEC_MAX_NAME_LENGTH = 64;
const SPEC_MAX_DESCRIPTION_LENGTH = 1024;
const SPEC_MAX_COMPATIBILITY_LENGTH = 500;
const SPEC_RECOMMENDED_BODY_LINES = 500;
const SPEC_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Читает скалярное поле фронтматтера, включая блочную форму YAML (`description: |`).
 *
 * Однострочного regex недостаточно: скилл, написанный по спецификации с многострочным
 * описанием, дал бы описание «|» — формально непустое, поэтому проверка бы его пропустила,
 * и в каталог попала бы палочка вместо текста.
 */
function readScalar(block, field) {
	const inline = block.match(new RegExp(`^\\s*${field}:\\s*(.+)\\s*$`, 'm'))?.[1]?.trim();
	if (inline && inline !== '|' && inline !== '>' && inline !== '|-' && inline !== '>-') {
		return inline.replace(/^["']|["']$/g, '');
	}
	if (!inline) {
		return '';
	}
	// Блочный скаляр: собираем последующие строки с бо́льшим отступом.
	const lines = block.split(/\r?\n/);
	const start = lines.findIndex(line => new RegExp(`^\\s*${field}:`).test(line));
	if (start < 0) {
		return '';
	}
	const baseIndent = (lines[start].match(/^\s*/) ?? [''])[0].length;
	const collected = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			collected.push('');
			continue;
		}
		const indent = (line.match(/^\s*/) ?? [''])[0].length;
		if (indent <= baseIndent) {
			break;
		}
		collected.push(line.trim());
	}
	// `|` сохраняет переводы строк, `>` их складывает; для проверки длины и показа в каталоге
	// разница несущественна, поэтому склеиваем пробелом в обоих случаях.
	return collected.join(' ').trim();
}

function parseSkillFrontmatter(filePath, raw) {
	const rel = path.relative(process.cwd(), filePath);
	const fm = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
	if (!fm) {
		return { rel, ok: false, errors: ['missing YAML frontmatter (--- ... ---)'] };
	}
	const block = fm[1];
	const errors = [];
	const warnings = [];
	const name = block.match(/^\s*name:\s*(.+)\s*$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '');
	const description = readScalar(block, 'description');
	// vibeVersion — наше унаследованное поле. В спецификации Agent Skills его нет, кастомные
	// свойства живут под `metadata`, поэтому читаем оба места и НЕ требуем ни одного: скилл,
	// написанный по стандарту, обязан у нас работать.
	const vv = block.match(/^\s*vibeVersion:\s*["']?([^"'\n]+)["']?\s*$/im)?.[1]?.trim()
		?? block.match(/^\s+vibeVersion:\s*["']?([^"'\n]+)["']?\s*$/im)?.[1]?.trim();
	const precheckRaw = block.match(/^\s*precheck:\s*(.+)\s*$/im)?.[1]?.trim()?.replace(/^["']|["']$/g, '') ?? '';
	const compatibility = readScalar(block, 'compatibility');
	const allowedTools = block.match(/^\s*allowed-tools:\s*(.+)\s*$/im)?.[1]?.trim()?.replace(/^["']|["']$/g, '') ?? '';

	const depends = parseDependsBlock(block);

	if (!name) {errors.push('missing name');}
	if (!description) {errors.push('missing description');}

	// Ограничения ниже — из спецификации Agent Skills. Проверяются именно они, потому что
	// нарушение каждого ломает вызов или отображение скилла, а прежний предел в 512 КБ при
	// рекомендации в 500 строк не срабатывал никогда.
	if (name) {
		if (name.length > SPEC_MAX_NAME_LENGTH) {
			errors.push(`name exceeds ${SPEC_MAX_NAME_LENGTH} characters`);
		}
		if (!SPEC_NAME_PATTERN.test(name)) {
			errors.push(`name "${name}" must be lowercase letters, digits and single hyphens (not leading or trailing)`);
		}
		// Расхождение имени с папкой ломает вызов молча: каталог показывает одно, обращение
		// идёт по другому.
		const dirName = path.basename(path.dirname(filePath));
		if (dirName && name !== dirName && !path.basename(filePath).toLowerCase().endsWith('.skill.md')) {
			errors.push(`name "${name}" must match the skill directory "${dirName}"`);
		}
	}
	if (description && description.length > SPEC_MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${SPEC_MAX_DESCRIPTION_LENGTH} characters`);
	}
	if (compatibility && compatibility.length > SPEC_MAX_COMPATIBILITY_LENGTH) {
		errors.push(`compatibility exceeds ${SPEC_MAX_COMPATIBILITY_LENGTH} characters`);
	}

	// Бюджет тела — рекомендация, а не запрет: длинный скилл работает, но съедает контекст,
	// который спека предлагает тратить на подгружаемые по требованию файлы.
	const body = raw.slice(fm[0].length);
	const bodyLines = body.split(/\r?\n/).length;
	if (bodyLines > SPEC_RECOMMENDED_BODY_LINES) {
		warnings.push(`body is ${bodyLines} lines; the spec recommends keeping SKILL.md under ${SPEC_RECOMMENDED_BODY_LINES} and moving detail into references/`);
	}

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
		warnings,
		skillId: name || path.basename(path.dirname(filePath)),
		description: description || '',
		vibeVersion: vv || null,
		compatibility: compatibility || null,
		allowedTools: allowedTools || null,
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
			if (!inner) {return [];}
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
		if (st === 1) {return true;}
		if (st === 2) {return false;}
		state.set(u, 1);
		for (const v of graph.get(u) || []) {
			if (!graph.has(v)) {continue;}
			if (dfs(v)) {return true;}
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
		for (const w of [...p.warnings, ...bundle.warnings]) {
			console.warn(`⚠️  ${p.rel}: ${w}`);
		}
		if (bundle.errors.length) {
			console.error(`❌ ${p.rel}: ${bundle.errors.join('; ')}`);
			exit = 1;
			continue;
		}
		if (!canonicalSet.has(f)) {
			console.log(`✅ ${p.rel} (${p.skillId}${p.vibeVersion ? `, vibeVersion ${p.vibeVersion}` : ''}) [locale sibling — not canonical id]`);
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
		console.log(`✅ ${p.rel} (${p.skillId}${p.vibeVersion ? `, vibeVersion ${p.vibeVersion}` : ''})`);
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
