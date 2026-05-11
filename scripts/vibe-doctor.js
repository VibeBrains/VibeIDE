#!/usr/bin/env node
/**
 * vibe doctor — VibeIDE diagnostics CLI
 *
 * Usage:
 *   node scripts/vibe-doctor.js              # fast mode (≤3s, blocking issues only)
 *   node scripts/vibe-doctor.js --full       # full audit (≤30s)
 *   node scripts/vibe-doctor.js --ci         # CI mode (no GUI checks)
 *   node scripts/vibe-doctor.js --repair     # interactive repair
 *   node scripts/vibe-doctor.js --json       # machine-readable output
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const projectCommandsAudit = require('./lib/project-commands-audit.cjs');
const npmCliAlignment = require('./lib/npm-cli-alignment-check.cjs');
const knowledgeMdStaleness = require('./lib/knowledge-md-staleness.cjs');
const perfGuardrails = require('./lib/perf-guardrails-aggregator.cjs');
const snapshotIntegrity = require('./lib/snapshot-integrity-check.cjs');
const memoryLayerRouter = require('./lib/memory-layer-router.cjs');

const args = process.argv.slice(2);
const MODE = {
	full: args.includes('--full'),
	ci: args.includes('--ci'),
	repair: args.includes('--repair'),
	json: args.includes('--json'),
	i18n: args.includes('--i18n'),
	network: args.includes('--network'),
	selfCheck: args.includes('--self-check'),
	knowledge: args.includes('--knowledge'),
	perf: args.includes('--perf'),
	memory: args.includes('--memory'),
	quarantineSnapshots: args.includes('--quarantine-snapshots'),
};

const results = [];

/** @param {string} rootDir @param {string[]} acc */
function walkSkillMarkdownFiles(rootDir, acc = []) {
	if (!fs.existsSync(rootDir)) {
		return acc;
	}
	for (const ent of fs.readdirSync(rootDir, { withFileTypes: true })) {
		const p = path.join(rootDir, ent.name);
		if (ent.isDirectory()) {
			walkSkillMarkdownFiles(p, acc);
		} else if (/skill\.md$/i.test(ent.name)) {
			acc.push(p);
		}
	}
	return acc;
}

/** @returns {string[]} issue codes */
function skillFrontmatterIssues(filePath) {
	const raw = fs.readFileSync(filePath, 'utf-8');
	const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
	if (!m) {
		return [];
	}
	const block = m[1];
	if (!/^\s*name:/m.test(block) || !/^\s*description:/m.test(block)) {
		return [];
	}
	if (!/^\s*vibeVersion:/im.test(block)) {
		return ['missing vibeVersion'];
	}
	return [];
}

if (MODE.repair) {
	const skillsRoot = path.join(process.cwd(), '.vibe', 'skills');
	const files = walkSkillMarkdownFiles(skillsRoot);
	const fixed = [];
	for (const f of files) {
		const raw = fs.readFileSync(f, 'utf-8');
		const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
		if (!m) {
			continue;
		}
		const block = m[1];
		if (!/^\s*name:/m.test(block) || !/^\s*description:/m.test(block)) {
			continue;
		}
		if (/^\s*vibeVersion:/im.test(block)) {
			continue;
		}
		const inserted = raw.replace(/^---\s*\r?\n/, '---\nvibeVersion: 1.0.0\n');
		fs.writeFileSync(f, inserted, 'utf-8');
		fixed.push(path.relative(process.cwd(), f));
	}
	if (fixed.length && !MODE.json) {
		console.log('\n🔧 Repair: added vibeVersion to skill frontmatter:\n' + fixed.map(x => `  - ${x}`).join('\n'));
	}

	// .vibe/commands.json — auto-repair `missing-vibe-version` only. All other audit
	// issues (duplicate-id, missing-command, invalid-id-pattern) need a human review,
	// so we never rewrite them silently.
	//
	// The decoder rejects files without `vibeVersion` outright (so the audit emits
	// `file-decode-failed`, not `missing-vibe-version`). To keep auto-repair useful
	// we sniff the raw shape directly — if it is a plain object but `vibeVersion`
	// is absent/empty, hand it to the helper for an immutable insert.
	const commandsPath = path.join(process.cwd(), '.vibe', 'commands.json');
	if (fs.existsSync(commandsPath)) {
		try {
			const raw = JSON.parse(fs.readFileSync(commandsPath, 'utf-8'));
			const needsVersion = raw !== null && typeof raw === 'object'
				&& (typeof raw.vibeVersion !== 'string' || raw.vibeVersion.length === 0);
			if (needsVersion) {
				const repaired = projectCommandsAudit.repairProjectCommandsForDoctor(raw, '1.0.0');
				if (repaired.repaired) {
					fs.writeFileSync(commandsPath, JSON.stringify(repaired.nextRaw, null, 2) + '\n', 'utf-8');
					if (!MODE.json) {
						console.log('\n🔧 Repair: ' + repaired.notes.join(', ') + ' in .vibe/commands.json');
					}
				}
			}
		} catch {
			// Audit-stage errors will surface through the regular `project-commands-schema`
			// check; we do not throw from --repair so other repairs continue.
		}
	}
}

function check(name, fn, severity = 'error', mode = 'fast') {
	if (mode === 'full' && !MODE.full && !MODE.ci) return;
	if (mode === 'ci' && !MODE.ci) return;

	try {
		const result = fn();
		const status = result ? 'ok' : 'error';
		results.push({ check: name, status, message: result || `${name} failed`, severity });
	} catch (e) {
		results.push({ check: name, status: 'error', message: e.message, severity });
	}
}

function checkWarning(name, fn, mode = 'fast') {
	check(name, fn, 'warning', mode);
}

// ──────────────────────────────────────────────────────────
// FAST CHECKS (always run, ≤3s)
// ──────────────────────────────────────────────────────────

// 1. API keys / local model (warning only — CI and fresh clones have no provider)
checkWarning('api-keys-configured', () => {
	const envVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
	const found = envVars.filter(v => process.env[v]);
	if (found.length > 0) return `API keys found: ${found.join(', ')}`;
	// Check if Ollama is available (local models)
	try {
		execSync('curl -s http://localhost:11434/api/tags', { timeout: 2000, stdio: 'pipe' });
		return 'Ollama running locally';
	} catch {
		return null; // No providers configured
	}
});

// 2. .vibe/ schema valid
check('vibe-schema-valid', () => {
	const vibePath = path.join(process.cwd(), '.vibe');
	if (!fs.existsSync(vibePath)) return '[skipped: no .vibe/ directory]';

	const filesToCheck = ['constraints.json', 'allowed-models.json', 'pinned.json'];
	const errors = [];

	for (const file of filesToCheck) {
		const filePath = path.join(vibePath, file);
		if (!fs.existsSync(filePath)) continue;
		try {
			const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
			if (!data.vibeVersion) errors.push(`${file}: missing vibeVersion`);
		} catch (e) {
			errors.push(`${file}: invalid JSON — ${e.message}`);
		}
	}

	if (errors.length > 0) throw new Error(errors.join('; '));
	return '.vibe/ files are valid';
});

// 2a. .vibe/commands.json schema audit (Project Commands roadmap §"vibe doctor"); covers
// duplicate-id / missing-command / invalid-id-pattern / missing-vibe-version. Audit-only
// summary — never echoes `command` / `env` bodies into vibe-doctor output to avoid
// leaking secret-substituted shell strings into CI logs.
checkWarning('project-commands-schema', () => {
	const filePath = path.join(process.cwd(), '.vibe', 'commands.json');
	if (!fs.existsSync(filePath)) return '[skipped: no .vibe/commands.json]';
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	} catch (e) {
		throw new Error(`.vibe/commands.json: invalid JSON — ${e.message}`);
	}
	const audit = projectCommandsAudit.auditProjectCommandsForDoctor(raw);
	if (audit.issues.length > 0) {
		throw new Error(
			projectCommandsAudit.summariseAuditIssues(audit.issues)
				+ '. Fix .vibe/commands.json or run `node scripts/vibe-doctor.js --repair` for auto-fixable items.',
		);
	}
	const count = audit.file ? audit.file.commands.length : 0;
	return `.vibe/commands.json — ${count} command(s), schema OK`;
});

// 3. Node.js version
check('node-version', () => {
	const version = process.version;
	const major = parseInt(version.slice(1));
	if (major < 18) throw new Error(`Node.js ${version} is too old. Minimum: v18`);
	return `Node.js ${version}`;
});

// 4. Windows long path (Windows only)
if (process.platform === 'win32') {
	check('windows-long-path', () => {
		try {
			const result = execSync('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled', { stdio: 'pipe', timeout: 2000 }).toString();
			if (result.includes('0x1')) return 'LongPathsEnabled: enabled';
			throw new Error('LongPathsEnabled is disabled. Run: reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f');
		} catch (e) {
			if (e.message.includes('LongPathsEnabled is disabled')) throw e;
			return '[skipped: registry check failed]';
		}
	});
}

// ──────────────────────────────────────────────────────────
// FULL CHECKS (--full flag)
// ──────────────────────────────────────────────────────────

check('npm-audit-critical', () => {
	try {
		const result = execSync('npm audit --json', { timeout: 30000, stdio: 'pipe' }).toString();
		const data = JSON.parse(result);
		const critical = data?.metadata?.vulnerabilities?.critical ?? 0;
		if (critical > 0) throw new Error(`${critical} critical npm vulnerabilities found. Run: npm audit fix`);
		return `npm audit: 0 critical vulnerabilities`;
	} catch (e) {
		if (e.message.includes('critical')) throw e;
		return `[skipped: npm audit unavailable]`;
	}
}, 'error', 'full');

check('roadmap-K0-DoD', () => {
	try {
		const out = execSync('node scripts/check-K0-DoD.mjs --json', { timeout: 5000, encoding: 'utf-8' });
		const { summary, violations } = JSON.parse(out);
		if (violations.length > 0) {
			throw new Error(`K.0 DoD: ${violations.length} item(s) without commit ref or blocker hint (${summary.open} open, ${summary.missingCommit} missing-commit). Run: node scripts/check-K0-DoD.mjs`);
		}
		return `roadmap K.0 DoD: ${summary.pass} pass / ${summary.blocked} blocked / 0 violations`;
	} catch (err) {
		if (err.message?.startsWith('K.0 DoD:')) { throw err; }
		return '[skipped: K.0 DoD checker unavailable]';
	}
}, 'warning', 'full');

check('phase-roadmap-sync', () => {
	try {
		const out = execSync('node scripts/sync-phase-roadmap.mjs --json', { timeout: 5000, encoding: 'utf-8' });
		const { reports } = JSON.parse(out);
		const totals = reports.reduce(
			(acc, r) => ({ open: acc.open + r.open, covered: acc.covered + r.covered }),
			{ open: 0, covered: 0 },
		);
		return `phase docs ↔ main roadmap: ${totals.covered}/${totals.open} open phase items have a likely main-roadmap counterpart`;
	} catch (err) {
		return `[skipped: phase-roadmap auditor unavailable: ${err.message?.split('\n')[0] ?? err}]`;
	}
}, 'warning', 'full');

check('vibe-snapshots-size', () => {
	const snapshotsPath = path.join(process.cwd(), '.vibe', 'snapshots');
	if (!fs.existsSync(snapshotsPath)) return '[skipped: no snapshots dir]';
	
	let totalBytes = 0;
	const files = fs.readdirSync(snapshotsPath);
	for (const file of files) {
		try {
			const stat = fs.statSync(path.join(snapshotsPath, file));
			totalBytes += stat.size;
		} catch {}
	}
	
	const mb = totalBytes / 1024 / 1024;
	if (mb > 500) {
		return `WARNING: .vibe/snapshots/ is ${mb.toFixed(0)}MB. Consider: vibe checkpoint prune --older-than 30d`;
	}
	return `.vibe/snapshots/: ${mb.toFixed(1)}MB`;
}, 'warning', 'full');

// ──────────────────────────────────────────────────────────
// CI CHECKS (--ci flag)
// ──────────────────────────────────────────────────────────

check('vibe-constraints-json', () => {
	const constraintsPath = path.join(process.cwd(), '.vibe', 'constraints.json');
	if (!fs.existsSync(constraintsPath)) return '[skipped: no constraints.json]';
	JSON.parse(fs.readFileSync(constraintsPath, 'utf-8')); // throws on invalid JSON
	return '.vibe/constraints.json is valid JSON';
}, 'error', 'ci');

checkWarning('skills-package-vibeVersion', () => {
	const skillsRoot = path.join(process.cwd(), '.vibe', 'skills');
	const files = walkSkillMarkdownFiles(skillsRoot);
	if (!files.length) return '[skipped: no SKILL.md under .vibe/skills]';
	const problems = [];
	for (const f of files) {
		for (const issue of skillFrontmatterIssues(f)) {
			problems.push(`${path.relative(process.cwd(), f)}: ${issue}`);
		}
	}
	if (problems.length) {
		throw new Error(problems.join('; ') + '. Fix: add vibeVersion to YAML or run `node scripts/vibe-doctor.js --repair`');
	}
	return `${files.length} SKILL.md — vibeVersion OK`;
});

checkWarning('plans-machine-context-json', () => {
	const plansDir = path.join(process.cwd(), '.vibe', 'plans');
	if (!fs.existsSync(plansDir)) return '[skipped: no .vibe/plans]';
	const plans = fs.readdirSync(plansDir).filter(n => /\.plan\.md$/i.test(n));
	if (!plans.length) return '[skipped: no *.plan.md]';
	const issues = [];
	for (const name of plans) {
		const fp = path.join(plansDir, name);
		let raw;
		try {
			raw = fs.readFileSync(fp, 'utf-8');
		} catch (e) {
			issues.push(`${name}: read failed — ${e.message}`);
			continue;
		}
		if (!/vibe-plan-machine-context/i.test(raw)) {
			continue;
		}
		const block = raw.match(/```json\s*\r?\n([\s\S]*?)```/);
		if (!block) {
			issues.push(`${name}: vibe-plan-machine-context without fenced json block`);
			continue;
		}
		try {
			JSON.parse(block[1]);
		} catch (e) {
			issues.push(`${name}: invalid machine JSON — ${e.message}`);
		}
	}
	if (issues.length) {
		throw new Error(issues.join('; '));
	}
	return `${plans.length} *.plan.md scanned (machine JSON OK where present)`;
});

/** @param {string} dir */
function directoryTotalBytes(dir) {
	let total = 0;
	if (!fs.existsSync(dir)) return 0;
	const stack = [dir];
	while (stack.length) {
		const d = stack.pop();
		let ents;
		try {
			ents = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const ent of ents) {
			const p = path.join(d, ent.name);
			try {
				if (ent.isDirectory()) {
					stack.push(p);
				} else if (ent.isFile()) {
					total += fs.statSync(p).size;
				}
			} catch {}
		}
	}
	return total;
}

function planFrontmatterActiveModelIssue(fileName, raw) {
	const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return null;
	const block = m[1];
	const am = block.match(/^\s*activeModel:\s*(.+)$/mi);
	if (!am) return null;
	let val = am[1].trim().replace(/^["']|["']$/g, '');
	if (!val || val === 'null') {
		return `${fileName}: activeModel is empty in YAML frontmatter`;
	}
	if (/api[_-]?key|client_secret|bearer|password|passwd|secret\s*[:=]/i.test(val)) {
		return `${fileName}: activeModel must be providerId/modelId only — remove secret-like material from frontmatter`;
	}
	// Expect registry-style id: provider / model (no spaces)
	if (!/^[\w.-]+\/[\S]+$/i.test(val) || /\s/.test(val)) {
		return `${fileName}: activeModel should look like registry ids \`providerId/modelId\` (got: ${val.slice(0, 64)})`;
	}
	return null;
}

checkWarning('plan-active-model-shape', () => {
	const plansDir = path.join(process.cwd(), '.vibe', 'plans');
	if (!fs.existsSync(plansDir)) return '[skipped: no .vibe/plans]';
	const plans = fs.readdirSync(plansDir).filter(n => /\.plan\.md$/i.test(n));
	if (!plans.length) return '[skipped: no *.plan.md]';
	const issues = [];
	for (const name of plans) {
		const fp = path.join(plansDir, name);
		let raw;
		try {
			raw = fs.readFileSync(fp, 'utf-8');
		} catch (e) {
			issues.push(`${name}: read failed — ${e.message}`);
			continue;
		}
		const issue = planFrontmatterActiveModelIssue(name, raw);
		if (issue) {
			issues.push(issue);
		}
	}
	if (issues.length) {
		throw new Error(issues.join('; ') + ' — fix frontmatter or remove activeModel; CDN/registry drift check is separate (UI remap backlog).');
	}
	return `${plans.length} *.plan.md — activeModel shape OK where present`;
});

/** @param {string} raw */
function planFrontmatterStatus(raw) {
	const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return undefined;
	const sm = m[1].match(/^\s*status:\s*(.+)$/m);
	if (!sm) return undefined;
	return sm[1].trim().replace(/^["']|["']$/g, '');
}

// Disk footprint + non-terminal plan statuses (full audit); mirrors checkpoint pruning UX hints.
checkWarning('plans-folder-footprint', () => {
	const plansDir = path.join(process.cwd(), '.vibe', 'plans');
	if (!fs.existsSync(plansDir)) return '[skipped: no .vibe/plans]';
	const bytes = directoryTotalBytes(plansDir);
	const mb = bytes / 1024 / 1024;
	const plans = fs.readdirSync(plansDir).filter(n => /\.plan\.md$/i.test(n));
	let failed = 0;
	let running = 0;
	for (const name of plans) {
		const fp = path.join(plansDir, name);
		let raw;
		try {
			raw = fs.readFileSync(fp, 'utf-8');
		} catch {
			continue;
		}
		const st = (planFrontmatterStatus(raw) || '').toLowerCase();
		if (st === 'failed') failed++;
		if (st === 'running') running++;
	}
	const softMb = 25;
	const hints = [];
	if (mb >= softMb) {
		hints.push(`.vibe/plans is ${mb.toFixed(1)}MB (≥${softMb}MB) — archive old *.plan.md or move artifacts outside plans/`);
	}
	if (failed > 0) {
		hints.push(`${failed} plan(s) with status failed — review, delete, or mark done after handling`);
	}
	if (running > 2) {
		hints.push(`${running} plan(s) marked running — verify leases/stale runs (see persisted plan resume UX)`);
	}
	if (hints.length) {
		throw new Error(hints.join(' | '));
	}
	if (!plans.length) return '[skipped: no *.plan.md]';
	return `.vibe/plans: ${mb.toFixed(2)}MB, ${plans.length} *.plan.md (footprint OK)`;
}, 'warning', 'full');

checkWarning('agent-locks-stale', () => {
	const locksPath = path.join(process.cwd(), '.vibe', 'agent-locks.json');
	if (!fs.existsSync(locksPath)) return '[skipped: no agent-locks.json]';
	let data;
	try {
		data = JSON.parse(fs.readFileSync(locksPath, 'utf-8'));
	} catch (e) {
		throw new Error(`invalid JSON — ${e.message}`);
	}
	const now = Date.now();
	const entries = [];
	if (Array.isArray(data)) {
		entries.push(...data);
	} else if (data && typeof data === 'object') {
		if (Array.isArray(data.locks)) {
			entries.push(...data.locks);
		} else if (data.holder !== undefined || data.until !== undefined) {
			entries.push(data);
		}
	}
	const problems = [];
	for (const e of entries) {
		if (!e || typeof e !== 'object') continue;
		const u = e.until;
		if (u === undefined || u === null) continue;
		const t = Date.parse(String(u));
		if (!Number.isFinite(t)) {
			problems.push(`invalid until: ${u}`);
		} else if (t < now) {
			problems.push(`expired lock (holder=${e.holder ?? '?'}) until=${u}`);
		}
	}
	if (problems.length) {
		throw new Error(problems.join('; ') + '. Remove stale entries or renew until.');
	}
	return `.vibe/agent-locks.json OK (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`;
});

// ──────────────────────────────────────────────────────────
// SUB-REPORTS (--i18n / --network) — separate from the standard checks output
// ──────────────────────────────────────────────────────────

function buildI18nReport() {
	const ROOT = process.cwd();
	const VIBE_SRC = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide');
	const NLS_DIR = path.join(ROOT, 'out', 'nls');

	function walkTs(dir, acc = []) {
		if (!fs.existsSync(dir)) {
			return acc;
		}
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				if (ent.name === 'node_modules' || ent.name === 'out' || ent.name === 'react') {
					continue;
				}
				walkTs(p, acc);
			} else if (/\.tsx?$/.test(ent.name)) {
				acc.push(p);
			}
		}
		return acc;
	}

	// Collect all (key, message) pairs from `localize(...)` and `localize2(...)` in source.
	const callRe = /\b(localize2?)\s*\(\s*(['"])((?:\\.|(?!\2).)*?)\2\s*,\s*(['"])((?:\\.|(?!\4).)*?)\4/g;
	const sourceMessages = new Map(); // key → message
	for (const file of walkTs(VIBE_SRC)) {
		const text = fs.readFileSync(file, 'utf-8');
		let m;
		while ((m = callRe.exec(text)) !== null) {
			sourceMessages.set(m[3], m[5]);
		}
	}
	const totalKeys = sourceMessages.size;

	// Locate locale bundles.
	const locales = [];
	if (fs.existsSync(NLS_DIR)) {
		for (const ent of fs.readdirSync(NLS_DIR, { withFileTypes: true })) {
			if (!ent.isFile()) continue;
			const m = ent.name.match(/^vibeide\.nls\.([a-zA-Z0-9_-]+)\.json$/);
			if (!m) continue;
			let bundle = {};
			try {
				bundle = JSON.parse(fs.readFileSync(path.join(NLS_DIR, ent.name), 'utf-8'));
			} catch { /* unreadable bundle counts as 0% */ }
			let translated = 0;
			let needsTranslation = 0;
			let stale = 0;
			for (const key of Object.keys(bundle)) {
				if (!sourceMessages.has(key)) continue;
				const value = bundle[key];
				if (typeof value !== 'string') continue;
				if (value.startsWith('[NEEDS_TRANSLATION]')) {
					needsTranslation += 1;
				} else if (value.length === 0) {
					/* empty: treat as needs */
					needsTranslation += 1;
				} else {
					translated += 1;
				}
				// Heuristic for stale: source key absent from bundle but present in source — handled below
			}
			const missing = [];
			for (const key of sourceMessages.keys()) {
				if (!Object.prototype.hasOwnProperty.call(bundle, key)) {
					missing.push(key);
				}
			}
			locales.push({
				locale: m[1],
				bundle: path.relative(ROOT, path.join(NLS_DIR, ent.name)),
				totalKeys,
				translated,
				needsTranslation,
				stale,
				missing: missing.length,
				missingKeys: missing.slice(0, 10), // first 10 for display
				coveragePercent: totalKeys === 0 ? 100 : Math.round((translated / totalKeys) * 100),
			});
		}
	}

	return { totalKeys, locales };
}

function buildNetworkReport() {
	const ROOT = process.cwd();
	const PRODUCT = path.join(ROOT, 'product.json');
	const MCP_PATH = path.join(ROOT, '.vibe', 'mcp.json');
	const PERMS = path.join(ROOT, '.vibe', 'permissions.json');

	function readJson(p) {
		try {
			return JSON.parse(fs.readFileSync(p, 'utf-8'));
		} catch {
			return null;
		}
	}

	const product = readJson(PRODUCT) ?? {};
	const mcp = readJson(MCP_PATH) ?? {};
	const perms = readJson(PERMS) ?? {};

	const endpoints = [];

	// Update channel
	if (product.updateUrl) {
		endpoints.push({ scope: 'update', url: product.updateUrl, source: 'product.json' });
	}
	if (product.releasesApiUrl) {
		endpoints.push({ scope: 'update', url: product.releasesApiUrl, source: 'product.json' });
	}
	// Models registry
	if (product.modelsRegistryUrl) {
		endpoints.push({ scope: 'models-registry', url: product.modelsRegistryUrl, source: 'product.json' });
	}
	// MCP servers
	if (mcp && typeof mcp === 'object' && mcp.mcpServers) {
		for (const [name, def] of Object.entries(mcp.mcpServers)) {
			const url = (def && typeof def === 'object' && (def.url || def.command)) || '<inline command>';
			endpoints.push({ scope: 'mcp', url: String(url), source: `.vibe/mcp.json#${name}` });
		}
	}
	// Provider hints from env (read-only, no secrets emitted)
	const providerEnv = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'];
	for (const v of providerEnv) {
		if (process.env[v]) {
			endpoints.push({ scope: 'provider', url: `<configured via ${v}>`, source: 'env' });
		}
	}
	// Privacy strict mode hint
	const strictMode = !!perms?.privacy?.strict;

	return {
		strictMode,
		endpoints,
		notes: strictMode
			? 'privacy.strict = true: only loopback (127.0.0.1) and explicitly allowed endpoints should be reachable.'
			: 'privacy.strict = false: outbound calls follow the per-feature settings.',
	};
}

if (MODE.i18n) {
	const report = buildI18nReport();
	if (MODE.json) {
		console.log(JSON.stringify(report, null, 2));
		process.exit(0);
	}
	console.log('\n🌐 VibeIDE i18n coverage');
	console.log('─'.repeat(40));
	console.log(`Total source keys: ${report.totalKeys}`);

	// Unwrapped user-facing literals (roadmap §478, §520) — printed even when
	// no locale bundles exist, since this is the inventory bottleneck.
	console.log('\n  Unwrapped user-facing literals:');
	try {
		const out = execSync('node scripts/scan-vibeide-i18n.mjs --json', { encoding: 'utf-8' });
		const summary = JSON.parse(out).summary;
		console.log(`    total findings:     ${summary.totalFindings} (across ${summary.totalFiles} files)`);
		for (const [k, v] of Object.entries(summary.byCallsite)) {
			if (v > 0) { console.log(`      ${k}: ${v}`); }
		}
	} catch (err) {
		console.log(`    (scanner unavailable: ${err.message.split('\n')[0]})`);
	}

	if (report.locales.length === 0) {
		console.log('\nNo locale bundles found under out/nls/. Run `node scripts/vibe-i18n-migrate.js --apply` first.');
		process.exit(0);
	}
	for (const l of report.locales) {
		console.log(`\n  [${l.locale}] ${l.bundle}`);
		console.log(`    coverage:           ${l.coveragePercent}% (${l.translated}/${l.totalKeys})`);
		console.log(`    needs-translation:  ${l.needsTranslation}`);
		console.log(`    missing in bundle:  ${l.missing}`);
		if (l.missingKeys.length > 0) {
			console.log('    sample missing keys:');
			for (const k of l.missingKeys) {
				console.log(`      - ${k}`);
			}
		}
	}

	process.exit(0);
}

if (MODE.network) {
	const report = buildNetworkReport();
	if (MODE.json) {
		console.log(JSON.stringify(report, null, 2));
		process.exit(0);
	}
	console.log('\n🌐 VibeIDE outbound endpoints (potential)');
	console.log('─'.repeat(40));
	console.log(`privacy.strict: ${report.strictMode}`);
	console.log(report.notes);
	if (report.endpoints.length === 0) {
		console.log('\nNo outbound endpoints declared.');
	} else {
		console.log('');
		const groups = new Map();
		for (const ep of report.endpoints) {
			const arr = groups.get(ep.scope) ?? [];
			arr.push(ep);
			groups.set(ep.scope, arr);
		}
		for (const [scope, eps] of groups) {
			console.log(`  [${scope}]`);
			for (const ep of eps) {
				console.log(`    ${ep.url}    (${ep.source})`);
			}
		}
	}
	console.log('\nThis report does NOT prove a build is offline-clean — it lists what could be');
	console.log('reached. The .github/workflows/privacy-verify.yml backlog item adds the runtime');
	console.log('sniffer that actually confirms strict mode.');
	process.exit(0);
}

if (MODE.perf) {
	// `vibe doctor --perf` — Performance Guardrails dashboard (roadmap L1056).
	// Reads .vibe/perf-guardrails-events.jsonl (one JSON event per line). When
	// the file is missing, renders an empty dashboard with a note so users see
	// the helper is wired even before runtime persistence lands.
	const eventsPath = path.join(process.cwd(), '.vibe', 'perf-guardrails-events.jsonl');
	const events = [];
	if (fs.existsSync(eventsPath)) {
		const raw = fs.readFileSync(eventsPath, 'utf-8');
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try { events.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
		}
	}
	const now = Date.now();
	const windowStart = now - 24 * 60 * 60 * 1000;
	const dashboard = perfGuardrails.aggregatePerfGuardrails(events, windowStart, now);
	if (MODE.json) {
		console.log(JSON.stringify(dashboard, null, 2));
	} else {
		console.log(perfGuardrails.renderGuardrailDashboardMarkdown(dashboard));
		if (!fs.existsSync(eventsPath)) {
			console.log('');
			console.log('Note: .vibe/perf-guardrails-events.jsonl not present — runtime persistence pending.');
			console.log('When the IDE-side guardrails service ships, every trip will append a JSONL line.');
		}
	}
	process.exit(0);
}

if (MODE.memory) {
	// `vibe doctor --memory` — audit memory layer health (roadmap §L1057).
	// Reads .vibe/memories.json (long-term layer) and checks for cross-layer
	// invariant violations via auditMemoryLayers. Runtime short-term memory
	// (vibeide.sessionMemory.v1 in WorkspaceStorage) is not accessible from CLI.
	const MEMORY_FILE = path.join(process.cwd(), '.vibe', 'memories.json');

	console.log('\n🧠 VibeIDE Memory Audit\n' + '─'.repeat(40));
	console.log('Memory layer contract: references/v1/memory-layers-contract.md');
	console.log('Layers: explicit | long-term (WorkspaceStorage) | short-term (SessionStorage)\n');

	if (!fs.existsSync(MEMORY_FILE)) {
		console.log('ℹ️  .vibe/memories.json not found — long-term memory is empty or stored in IDE workspace state.');
		console.log('   This is normal for a fresh workspace.');
	} else {
		let records = [];
		try {
			const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
			records = Array.isArray(raw) ? raw : (raw.memories ?? []);
			console.log(`Found ${records.length} long-term memory record(s).`);
		} catch (err) {
			console.error(`❌ Failed to parse ${MEMORY_FILE}: ${err.message}`);
		}

		if (records.length > 0) {
			const warnings = memoryLayerRouter.auditMemoryLayers(records);
			if (warnings.length === 0) {
				console.log('✅ No cross-layer invariant violations found.');
			} else {
				console.warn(`⚠️  ${warnings.length} layer invariant violation(s):`);
				for (const w of warnings.slice(0, 10)) {
					console.warn(`   [${w.kind}] ${w.key}: ${w.detail}`);
				}
			}
		}
	}

	console.log('\nNote: Short-term memory (session) is only accessible from a running IDE instance.');
	process.exit(0);
}

if (MODE.knowledge) {
	// `vibe doctor --knowledge` — flag stale docs/knowledge.md against drift in
	// contrib/vibeide/common/* (roadmap §M.0 L1092). Exits 0; warn-only.
	const cwd = process.cwd();
	const knowledgePath = path.join(cwd, 'docs', 'knowledge.md');
	const commonDir = path.join(cwd, 'src', 'vs', 'workbench', 'contrib', 'vibeide', 'common');

	let fileExists = false;
	let fileMtimeMs = null;
	try {
		const st = fs.statSync(knowledgePath);
		fileExists = true;
		fileMtimeMs = st.mtimeMs;
	} catch {
		// silent: knowledge.md is opt-in
	}

	const commonServiceFiles = [];
	function walkCommon(dir, rel) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			const relPath = rel ? `${rel}/${ent.name}` : ent.name;
			if (ent.isDirectory()) {
				walkCommon(full, relPath);
			} else if (ent.isFile() && /\.ts$/.test(ent.name) && !/\.test\.ts$/.test(ent.name)) {
				try {
					const st = fs.statSync(full);
					commonServiceFiles.push({ path: relPath, mtimeMs: st.mtimeMs });
				} catch { /* ignore */ }
			}
		}
	}
	walkCommon(commonDir, '');

	const decision = knowledgeMdStaleness.decideKnowledgeStaleness({
		fileExists,
		fileMtimeMs,
		commonServiceFiles,
		nowMs: Date.now(),
	});

	if (MODE.json) {
		console.log(JSON.stringify(decision, null, 2));
	} else {
		console.log(knowledgeMdStaleness.renderKnowledgeStaleness(decision));
	}
	process.exit(0);
}

if (MODE.selfCheck) {
	// `vibe doctor --self-check` — static audit of npm scripts ↔ scripts/vibe.js
	// alignment (roadmap L1136). Exits 1 on any violation so CI can gate.
	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
	} catch (e) {
		const message = e && e.message ? e.message : String(e);
		if (MODE.json) {
			console.log(JSON.stringify({ ok: false, error: `package.json read failed: ${message}` }));
		} else {
			console.error(`✗ package.json read failed: ${message}`);
		}
		process.exit(2);
	}
	const report = npmCliAlignment.checkNpmCliAlignment(pkg.scripts || {});
	if (MODE.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(npmCliAlignment.renderAlignmentReport(report));
	}
	process.exit(report.violations.length === 0 ? 0 : 1);
}

if (MODE.quarantineSnapshots) {
	// `vibe doctor --quarantine-snapshots` — snapshot integrity check (roadmap L1034).
	// Reads .vibe/snapshots/*.json, checks each via snapshotIntegrity.checkSnapshotsIntegrity,
	// and if --repair is also passed, moves corrupt files to .vibe/snapshots/.quarantine/.
	const snapshotsDir = path.join(process.cwd(), '.vibe', 'snapshots');
	if (!fs.existsSync(snapshotsDir)) {
		if (MODE.json) { console.log(JSON.stringify({ ok: [], corrupt: [], note: 'no-snapshots-dir' })); }
		else { console.log('No .vibe/snapshots/ directory — nothing to check.'); }
		process.exit(0);
	}
	const entries = [];
	for (const file of fs.readdirSync(snapshotsDir)) {
		if (!file.endsWith('.json') || file.startsWith('.')) continue;
		const id = file.replace(/\.json$/, '');
		const fullPath = path.join(snapshotsDir, file);
		let raw = null;
		let rawSize;
		try {
			const text = fs.readFileSync(fullPath, 'utf-8');
			rawSize = Buffer.byteLength(text, 'utf-8');
			raw = JSON.parse(text);
		} catch { raw = null; }
		entries.push({ id, raw, rawSize });
	}
	const result = snapshotIntegrity.checkSnapshotsIntegrity(entries);
	if (MODE.json) {
		console.log(JSON.stringify(result, null, 2));
		process.exit(result.corrupt.length > 0 ? 1 : 0);
	}
	if (result.corrupt.length === 0) {
		console.log(`✅ .vibe/snapshots/: ${result.ok.length} OK, 0 corrupt.`);
		process.exit(0);
	}
	console.log(snapshotIntegrity.renderCorruptSnapshotReport(result.corrupt));
	if (MODE.repair) {
		const quarantineDir = path.join(snapshotsDir, '.quarantine');
		fs.mkdirSync(quarantineDir, { recursive: true });
		for (const bad of result.corrupt) {
			const src = path.join(snapshotsDir, bad.id + '.json');
			const dst = path.join(quarantineDir, bad.id + '.json');
			if (fs.existsSync(src)) {
				fs.renameSync(src, dst);
				console.log(`  moved: ${bad.id}.json → .quarantine/`);
			}
		}
		console.log(`Quarantined ${result.corrupt.length} corrupt file(s). Healthy snapshots: ${result.ok.length}.`);
	}
	process.exit(result.corrupt.length > 0 ? 1 : 0);
}

// ──────────────────────────────────────────────────────────
// OUTPUT
// ──────────────────────────────────────────────────────────

if (MODE.json) {
	console.log(JSON.stringify(results, null, 2));
} else {
	console.log('\n🔬 VibeIDE Doctor\n' + '─'.repeat(40));
	
	const modeLabel = MODE.full ? 'full' : MODE.ci ? 'ci' : 'fast';
	console.log(`Mode: ${modeLabel}\n`);
	
	for (const r of results) {
		const icon = r.status === 'ok' ? '✅' : r.severity === 'warning' ? '⚠️' : '❌';
		console.log(`${icon} ${r.check}: ${r.message}`);
	}
	
	const errors = results.filter(r => r.status === 'error' && r.severity === 'error');
	const warnings = results.filter(r => r.status === 'error' && r.severity === 'warning');
	
	console.log('\n' + '─'.repeat(40));
	console.log(`Results: ${results.filter(r => r.status === 'ok').length} OK, ${errors.length} errors, ${warnings.length} warnings`);
	
	if (errors.length > 0) {
		console.log('\n❌ Issues found. Fix before deploying.');
		process.exit(1);
	}
}
