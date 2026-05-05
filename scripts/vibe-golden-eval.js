#!/usr/bin/env node
/**
 * vibe-golden-eval — golden scenario runner for VibeIDE agent quality regression.
 *
 * Runs a small, closed set of deterministic tasks against the agent and checks
 * that outputs match expected criteria (file existence, content patterns, no crashes).
 * No code or results are sent outside the local machine.
 *
 * Usage:
 *   node scripts/vibe-golden-eval.js               # run all scenarios
 *   node scripts/vibe-golden-eval.js --suite smoke # run only smoke suite
 *   node scripts/vibe-golden-eval.js --json        # machine-readable output
 *   node scripts/vibe-golden-eval.js --ci          # exit 1 if any scenario fails
 *
 * Scenarios live in .vibe/golden-evals/<scenario-id>.json
 * Format: { id, name, suite, prompt, expectedFiles, expectedPatterns, forbiddenPatterns }
 *
 * Integration:
 *   - Add "vibe:golden:eval" to package.json scripts
 *   - Optionally call from `vibe doctor --full` as a quality check
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flagJson = args.includes('--json');
const flagCi = args.includes('--ci');
const suiteFilter = args.includes('--suite') ? args[args.indexOf('--suite') + 1] : null;

// ── Scenario loader ────────────────────────────────────────────────────────────

const EVALS_DIR = path.join(process.cwd(), '.vibe', 'golden-evals');
const EXAMPLES_DIR = path.join(process.cwd(), 'references', 'v1', 'golden-evals');

function loadScenarios() {
	const scenarios = [];

	// Load from workspace .vibe/golden-evals/
	if (fs.existsSync(EVALS_DIR)) {
		for (const f of fs.readdirSync(EVALS_DIR).filter(f => f.endsWith('.json'))) {
			try {
				const raw = JSON.parse(fs.readFileSync(path.join(EVALS_DIR, f), 'utf8'));
				scenarios.push(raw);
			} catch (e) {
				console.warn(`[golden-eval] Warning: failed to parse ${f}: ${e.message}`);
			}
		}
	}

	// Load built-in example scenarios from references/v1/golden-evals/ (read-only reference)
	if (fs.existsSync(EXAMPLES_DIR)) {
		for (const f of fs.readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.json'))) {
			try {
				const raw = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, f), 'utf8'));
				raw._builtin = true;
				scenarios.push(raw);
			} catch { /* ignore */ }
		}
	}

	return scenarios;
}

// ── Scenario runner ────────────────────────────────────────────────────────────

/**
 * Run a single scenario (MVP: static checks without full agent loop).
 * Phase 3b: wire into actual vibe agent IPC for real execution.
 */
function runScenario(scenario) {
	const result = {
		id: scenario.id,
		name: scenario.name,
		suite: scenario.suite ?? 'default',
		status: 'pass',
		checks: [],
		durationMs: 0,
		_builtin: scenario._builtin ?? false,
	};
	const start = Date.now();

	// MVP: static checks only (file existence, pattern match against existing files)
	// Phase 3b: spawn agent, apply prompt, check outputs
	if (scenario.expectedFiles) {
		for (const rel of scenario.expectedFiles) {
			const abs = path.join(process.cwd(), rel);
			const exists = fs.existsSync(abs);
			result.checks.push({ type: 'file_exists', path: rel, passed: exists });
			if (!exists) { result.status = 'fail'; }
		}
	}

	if (scenario.expectedPatterns && scenario.checkFiles) {
		for (const rel of scenario.checkFiles) {
			const abs = path.join(process.cwd(), rel);
			if (!fs.existsSync(abs)) { continue; }
			const content = fs.readFileSync(abs, 'utf8');
			for (const pattern of scenario.expectedPatterns) {
				const re = new RegExp(pattern);
				const matched = re.test(content);
				result.checks.push({ type: 'pattern_match', file: rel, pattern, passed: matched });
				if (!matched) { result.status = 'fail'; }
			}
		}
	}

	if (scenario.forbiddenPatterns && scenario.checkFiles) {
		for (const rel of scenario.checkFiles) {
			const abs = path.join(process.cwd(), rel);
			if (!fs.existsSync(abs)) { continue; }
			const content = fs.readFileSync(abs, 'utf8');
			for (const pattern of scenario.forbiddenPatterns) {
				const re = new RegExp(pattern);
				const matched = re.test(content);
				result.checks.push({ type: 'forbidden_pattern', file: rel, pattern, passed: !matched });
				if (matched) { result.status = 'fail'; }
			}
		}
	}

	result.durationMs = Date.now() - start;

	// MVP static scenarios always pass if no checks are defined (smoke: just verify tool runs)
	if (result.checks.length === 0) {
		result.checks.push({ type: 'smoke', passed: true, note: 'No checks configured — smoke pass' });
	}

	return result;
}

// ── Main ────────────────────────────────────────────────────────────────────────

function main() {
	let scenarios = loadScenarios();

	if (suiteFilter) {
		scenarios = scenarios.filter(s => s.suite === suiteFilter);
	}

	if (scenarios.length === 0) {
		const msg = `[golden-eval] No scenarios found. Create .vibe/golden-evals/<id>.json to add scenarios.`;
		if (flagJson) {
			console.log(JSON.stringify({ scenarios: [], summary: { total: 0, passed: 0, failed: 0 } }, null, 2));
		} else {
			console.log(msg);
		}
		return;
	}

	const results = scenarios.map(runScenario);
	const passed = results.filter(r => r.status === 'pass').length;
	const failed = results.filter(r => r.status === 'fail').length;

	if (flagJson) {
		console.log(JSON.stringify({ scenarios: results, summary: { total: results.length, passed, failed } }, null, 2));
	} else {
		console.log(`\n🧪 Golden Eval Results (${results.length} scenarios)\n`);
		for (const r of results) {
			const icon = r.status === 'pass' ? '✅' : '❌';
			console.log(`  ${icon} [${r.suite}] ${r.name} (${r.durationMs}ms)`);
			for (const c of r.checks) {
				const ci = c.passed ? '    ✓' : '    ✗';
				const detail = c.type === 'file_exists' ? `file: ${c.path}` : c.type === 'pattern_match' ? `pattern /${c.pattern}/ in ${c.file}` : c.type === 'forbidden_pattern' ? `no pattern /${c.pattern}/ in ${c.file}` : c.note ?? c.type;
				console.log(`${ci} ${detail}`);
			}
		}
		console.log(`\nSummary: ${passed} passed, ${failed} failed out of ${results.length}\n`);
	}

	if (flagCi && failed > 0) {
		process.exit(1);
	}
}

main();
