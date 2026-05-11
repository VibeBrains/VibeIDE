#!/usr/bin/env node
/**
 * vibe — single CLI entry-point that dispatches into scripts/vibe-*.js.
 *
 * Usage:
 *   vibe --version                           # prints vibeVersion + git SHA
 *   vibe --help                              # grouped command list
 *   vibe doctor [--full|--ci|--repair|--i18n|--network|--json]
 *   vibe skills <validate|list>              # → scripts/vibe-skills.js
 *   vibe plan-merge-driver <args>            # → scripts/vibe-plan-merge-driver.js
 *   vibe plan-pr-export [--latest|--file p]  # → scripts/vibe-plan-pr-export.js
 *   vibe agent reset-leases [--force]        # → scripts/vibe-agent-reset-leases.js
 *   vibe i18n-migrate [--apply]              # → scripts/vibe-i18n-migrate.js
 *   vibe services-inventory [--json]         # → scripts/vibe-services-inventory.js
 *   vibe docs-dedup                          # → scripts/vibe-docs-dedup.js
 *   vibe roadmap-sync [--since=<rev>]        # → scripts/vibe-roadmap-sync.js
 *   vibe release-lint [--stdin] [--tag …]    # → scripts/vibe-release-lint.js
 *   vibe changelog [--since v…]              # → scripts/vibe-changelog.js
 *   vibe commit                              # → scripts/vibe-commit.js
 *   vibe review <branch>                     # → scripts/vibe-review.js
 *   vibe explain [args]                      # → scripts/vibe-explain.js
 *   vibe audit <commit>                      # → scripts/vibe-audit.js
 *   vibe bisect [args]                       # → scripts/vibe-bisect.js
 *   vibe checkpoint-prune [args]             # → scripts/vibe-checkpoint-prune.js
 *   vibe leak-check [args]                   # → scripts/vibe-leak-check.js
 *
 * The dispatcher does NOT re-implement subcommand logic. It spawns the underlying
 * Node script with the user's argv and propagates the exit code. Existing npm scripts
 * (`vibe:skills:*`, etc.) remain thin wrappers around the same Node files; both paths
 * share one source of truth.
 *
 * To use as `vibe <command>` from anywhere, install globally with `npm link` from the
 * repo root once the `bin` field in package.json points at this file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = __dirname;

const argv = process.argv.slice(2);

function readVibeVersion() {
	try {
		const product = JSON.parse(fs.readFileSync(path.join(ROOT, 'product.json'), 'utf-8'));
		return product.vibeVersion || product.version || '<unknown>';
	} catch {
		return '<unknown>';
	}
}

function readGitSha() {
	try {
		return execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
	} catch {
		return '<no-git>';
	}
}

function printVersion() {
	const vibeVersion = readVibeVersion();
	const gitSha = readGitSha();
	console.log(`VibeIDE ${vibeVersion} (git ${gitSha})`);
}

function printHelp() {
	const groups = {
		'Project': ['init-from', 'doctor', 'commit', 'review', 'roadmap-sync', 'docs-dedup'],
		'Agent':   ['agent reset-leases', 'audit', 'bisect', 'checkpoint-prune'],
		'Plans':   ['plan-pr-export', 'plan-merge-driver'],
		'Skills':  ['skills validate', 'skills list'],
		'Release': ['changelog', 'release-lint'],
		'i18n':    ['i18n-migrate'],
		'Inventory': ['services-inventory', 'leak-check'],
	};
	console.log('vibe — VibeIDE command-line tool');
	console.log('');
	console.log('Usage: vibe <command> [args]');
	console.log('       vibe --version');
	console.log('');
	for (const [group, commands] of Object.entries(groups)) {
		console.log(`${group}:`);
		for (const c of commands) {
			console.log(`  vibe ${c}`);
		}
		console.log('');
	}
	console.log('Run `vibe <command> --help` for command-specific options (forwarded to the underlying script).');
}

const COMMAND_MAP = {
	'doctor':                'vibe-doctor.js',
	'skills':                'vibe-skills.js',
	'plan-merge-driver':     'vibe-plan-merge-driver.js',
	'plan-pr-export':        'vibe-plan-pr-export.js',
	'i18n-migrate':          'vibe-i18n-migrate.js',
	'services-inventory':    'vibe-services-inventory.js',
	'docs-dedup':            'vibe-docs-dedup.js',
	'roadmap-sync':          'vibe-roadmap-sync.js',
	'release-lint':          'vibe-release-lint.js',
	'changelog':             'vibe-changelog.js',
	'commit':                'vibe-commit.js',
	'review':                'vibe-review.js',
	'explain':               'vibe-explain.js',
	'audit':                 'vibe-audit.js',
	'bisect':                'vibe-bisect.js',
	'checkpoint-prune':      'vibe-checkpoint-prune.js',
	'leak-check':            'vibe-leak-check.js',
	'snapshot':              'vibe-snapshot.js',
	'session-export':        'vibe-session-export.js',
	'session-replay':        'vibe-session-replay.js',
	'benchmark':             'vibe-benchmark.js',
	'init-from':             'vibe-init-from.js',
	// Added in the npm-scripts ↔ CLI alignment sweep (roadmap L1136):
	'diff-split':            'vibe-diff-split.js',
	'gitignore-wizard':      'vibe-gitignore-wizard.js',
	'init-for-new-member':   'vibe-init-for-new-member.js',
	'migration-guide':       'vibe-migration-guide.js',
	'otel-export':           'vibe-otel-export.js',
	'run':                   'vibe-run.js',
	'schema-templates':      'vibe-schema-templates.js',
	'transparency-dashboard':'vibe-transparency-dashboard.js',
	'workspace-template':    'vibe-workspace-template.js',
};

function dispatch() {
	if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
		printHelp();
		return 0;
	}
	if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
		printVersion();
		return 0;
	}

	// Two-word special form: `vibe agent reset-leases ...` → vibe-agent-reset-leases.js
	if (argv[0] === 'agent' && argv[1] === 'reset-leases') {
		return runScript('vibe-agent-reset-leases.js', argv.slice(2));
	}

	const cmd = argv[0];
	const script = COMMAND_MAP[cmd];
	if (!script) {
		console.error(`vibe: unknown command '${cmd}'. Run 'vibe --help'.`);
		return 64;
	}
	return runScript(script, argv.slice(1));
}

function runScript(scriptName, restArgs) {
	const target = path.join(SCRIPTS, scriptName);
	if (!fs.existsSync(target)) {
		console.error(`vibe: missing script ${path.relative(ROOT, target)}`);
		return 70;
	}
	const result = spawnSync(process.execPath, [target, ...restArgs], { stdio: 'inherit' });
	if (result.error) {
		console.error(`vibe: failed to spawn ${scriptName}: ${result.error.message}`);
		return 1;
	}
	return result.status ?? 0;
}

process.exit(dispatch());
