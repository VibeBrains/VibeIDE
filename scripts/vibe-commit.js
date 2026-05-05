#!/usr/bin/env node
/**
 * vibe commit — AI-generated conventional commit message from diff + audit log
 *
 * Usage:
 *   node scripts/vibe-commit.js
 *   node scripts/vibe-commit.js --dry-run   # show message without committing
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

/**
 * Analyze staged diff and generate a conventional commit message.
 * Uses heuristics (no LLM call) to produce a structured message.
 * Phase 2 will add actual LLM-based generation.
 */
function generateCommitMessage() {
	let diff;
	try {
		diff = execSync('git diff --cached --stat', { encoding: 'utf-8', timeout: 5000 });
	} catch {
		console.error('No staged changes. Run: git add <files>');
		process.exit(1);
	}

	if (!diff.trim()) {
		console.error('No staged changes. Run: git add <files>');
		process.exit(1);
	}

	// Parse file changes from diff stat
	const lines = diff.trim().split('\n');
	const summary = lines[lines.length - 1]; // e.g., "3 files changed, 42 insertions(+), 8 deletions(-)"
	const fileLines = lines.slice(0, -1);

	const changedFiles = fileLines.map(l => l.trim().split(' ')[0]).filter(Boolean);
	const insertions = parseInt(summary.match(/(\d+) insertion/)?.[1] ?? '0');
	const deletions = parseInt(summary.match(/(\d+) deletion/)?.[1] ?? '0');

	// Determine commit type from changed files
	let type = 'chore';
	let scope = '';

	const allFiles = changedFiles.join(' ');

	if (allFiles.includes('test') || allFiles.includes('spec') || allFiles.includes('.test.')) {
		type = 'test';
	} else if (allFiles.includes('.md') || allFiles.includes('docs/') || allFiles.includes('README')) {
		type = 'docs';
	} else if (allFiles.includes('package.json') || allFiles.includes('package-lock.json') || allFiles.includes('.yml') || allFiles.includes('.yaml')) {
		type = 'build';
	} else if (deletions > insertions * 2) {
		type = 'refactor';
	} else if (insertions > 0 && deletions === 0) {
		type = 'feat';
	} else {
		type = 'fix';
	}

	// Determine scope from most common directory
	const dirs = changedFiles
		.map(f => f.split('/').slice(0, -1).join('/'))
		.filter(d => d.length > 0);
	if (dirs.length > 0) {
		const dirCounts = {};
		dirs.forEach(d => { dirCounts[d] = (dirCounts[d] || 0) + 1; });
		scope = Object.entries(dirCounts).sort((a, b) => b[1] - a[1])[0][0].split('/').pop() || '';
	}

	// Build description
	const fileCount = changedFiles.length;
	const description = fileCount === 1
		? `update ${changedFiles[0].split('/').pop()}`
		: `update ${fileCount} files`;

	const scopeStr = scope ? `(${scope})` : '';
	const message = `${type}${scopeStr}: ${description}\n\n` +
		`Changed: ${changedFiles.slice(0, 5).join(', ')}${changedFiles.length > 5 ? '...' : ''}\n` +
		`+${insertions} -${deletions}\n\n` +
		`Co-authored-by: VibeIDE Agent <agent@vibeide.local>`;

	return message;
}

// Main
const message = generateCommitMessage();
console.log('Generated commit message:\n' + '─'.repeat(40));
console.log(message);
console.log('─'.repeat(40));

if (DRY_RUN) {
	console.log('\n[dry-run] Not committing.');
	process.exit(0);
}

// Write to temp file and commit
const tmpFile = path.join(require('os').tmpdir(), `vibe-commit-${Date.now()}.txt`);
fs.writeFileSync(tmpFile, message);

try {
	execSync(`git commit -F "${tmpFile}"`, { stdio: 'inherit' });
} finally {
	fs.unlinkSync(tmpFile);
}
