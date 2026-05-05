#!/usr/bin/env node
/**
 * vibe diff --split-commits — split a large diff into logical atomic commits
 *
 * Usage:
 *   node scripts/vibe-diff-split.js
 *   node scripts/vibe-diff-split.js --dry-run
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function getStagedFiles() {
	try {
		const result = execSync('git diff --cached --name-only', { encoding: 'utf-8' });
		return result.trim().split('\n').filter(Boolean);
	} catch { return []; }
}

function categorizeFile(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	const name = path.basename(filePath).toLowerCase();
	const dir = filePath.split('/')[0];

	if (name.includes('test') || name.includes('spec') || dir === 'test' || dir === 'tests' || dir === '__tests__') return 'test';
	if (name.includes('readme') || ext === '.md' || ext === '.txt' || dir === 'docs') return 'docs';
	if (name === 'package.json' || name === 'package-lock.json' || ext === '.yml' || ext === '.yaml' || dir === '.github') return 'build';
	if (ext === '.json' || ext === '.toml' || ext === '.ini' || ext === '.env') return 'config';
	return 'feat';
}

function groupIntoCommits(files) {
	const groups = {};
	for (const file of files) {
		const category = categorizeFile(file);
		const dir = file.split('/').slice(0, 2).join('/');
		const key = `${category}/${dir}`;
		if (!groups[key]) groups[key] = { category, files: [] };
		groups[key].files.push(file);
	}
	return Object.values(groups);
}

const stagedFiles = getStagedFiles();

if (stagedFiles.length === 0) {
	console.log('No staged files. Run: git add <files>');
	process.exit(0);
}

if (stagedFiles.length <= 5) {
	console.log(`${stagedFiles.length} files staged — no split needed.`);
	process.exit(0);
}

const groups = groupIntoCommits(stagedFiles);

console.log(`\n📦 vibe diff --split-commits\n${'─'.repeat(50)}`);
console.log(`${stagedFiles.length} staged files → ${groups.length} logical commits\n`);

groups.forEach((group, i) => {
	const message = `${group.category}: update ${group.files[0].split('/').pop()}${group.files.length > 1 ? ` and ${group.files.length - 1} more` : ''}`;
	console.log(`Commit ${i + 1}: ${message}`);
	group.files.forEach(f => console.log(`  - ${f}`));
	console.log('');
});

if (DRY_RUN) {
	console.log('[dry-run] No commits made.');
	process.exit(0);
}

console.log('⚠️  Auto-splitting requires interactive mode.');
console.log('   Phase 2 will implement AST-based atomic splitting.');
console.log('\n   For now: unstage all, then stage and commit each group manually.');
console.log('   Or use: git add -p (interactive staging)');
