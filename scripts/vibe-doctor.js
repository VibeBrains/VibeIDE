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

const args = process.argv.slice(2);
const MODE = {
	full: args.includes('--full'),
	ci: args.includes('--ci'),
	repair: args.includes('--repair'),
	json: args.includes('--json'),
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

// 1. API keys configured
check('api-keys-configured', () => {
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
