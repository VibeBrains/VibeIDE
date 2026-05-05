#!/usr/bin/env node
/**
 * vibe gitignore wizard — adds .vibe/ entries to .gitignore
 * Called by vibe init to protect sensitive .vibe/ files.
 *
 * Usage:
 *   node scripts/vibe-gitignore-wizard.js [--public|--private] [--workspace /path]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
const WORKSPACE = args.find(a => a.startsWith('--workspace='))?.split('=')[1]
	|| (args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : null)
	|| process.cwd();

const FORCE_PUBLIC = args.includes('--public');
const FORCE_PRIVATE = args.includes('--private');

// Files to add to .gitignore for public repos
const PUBLIC_REPO_IGNORES = [
	'.vibe/permissions.json',
	'.vibe/profiles/',
	'.vibe/persona.json',
	'.vibe/goals.md',
	'# Agent plan drafts — remove this line and the next if your team commits *.plan.md as docs',
	'.vibe/plans/**/*.plan.md',
];

// Files to add to .gitignore for private repos (minimal)
const PRIVATE_REPO_IGNORES = [
	'.vibe/permissions.json',
];

async function askPublicOrPrivate() {
	if (FORCE_PUBLIC) return 'public';
	if (FORCE_PRIVATE) return 'private';

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise(resolve => {
		rl.question('Is this a public repository? (y/N): ', answer => {
			rl.close();
			resolve(answer.toLowerCase().startsWith('y') ? 'public' : 'private');
		});
	});
}

function addToGitignore(workspacePath, entries) {
	const gitignorePath = path.join(workspacePath, '.gitignore');
	let existing = '';

	if (fs.existsSync(gitignorePath)) {
		existing = fs.readFileSync(gitignorePath, 'utf-8');
	}

	const toAdd = entries.filter(e => !existing.includes(e));
	if (toAdd.length === 0) {
		console.log('All entries already in .gitignore ✅');
		return;
	}

	const section = `\n# VibeIDE — sensitive configuration\n${toAdd.join('\n')}\n`;
	fs.appendFileSync(gitignorePath, section);
	console.log(`Added to .gitignore:\n${toAdd.map(e => `  ${e}`).join('\n')}`);
}

async function main() {
	console.log('🔐 VibeIDE .gitignore wizard\n');

	const repoType = await askPublicOrPrivate();
	const entries = repoType === 'public' ? PUBLIC_REPO_IGNORES : PRIVATE_REPO_IGNORES;

	console.log(`\nRepo type: ${repoType}`);
	console.log(`Entries to protect: ${entries.join(', ')}\n`);

	addToGitignore(WORKSPACE, entries);

	console.log('\n✅ Done. Review .gitignore to ensure sensitive files are protected.');
	if (repoType === 'public') {
		console.log('💡 Tip: .vibe/rules.md and .vibe/constraints.json are public by default.');
		console.log('   This helps others clone your project with the same AI settings.');
		console.log('💡 Tip: draft plans under .vibe/plans/*.plan.md are ignored by default; delete those lines in .gitignore if you version plans.');
	}
}

main().catch(e => { console.error(e); process.exit(1); });
