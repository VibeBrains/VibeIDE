#!/usr/bin/env node
/**
 * vibe changelog — generate CHANGELOG from git history + audit log
 * Separates AI-assisted changes from manual changes.
 *
 * Usage:
 *   node scripts/vibe-changelog.js
 *   node scripts/vibe-changelog.js --since v1.0.0
 *   node scripts/vibe-changelog.js --format markdown|json
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const SINCE = args.find(a => a.startsWith('--since='))?.split('=')[1]
	|| (args.includes('--since') ? args[args.indexOf('--since') + 1] : null);
const FORMAT = args.find(a => a.startsWith('--format='))?.split('=')[1]
	|| (args.includes('--format') ? args[args.indexOf('--format') + 1] : 'markdown');

function getCommits(since) {
	const range = since ? `${since}..HEAD` : '--max-count=50';
	try {
		const log = execSync(`git log ${range} --pretty=format:"%H|%s|%an|%ae|%ad" --date=short`, {
			encoding: 'utf-8', timeout: 10000
		});
		return log.trim().split('\n').filter(Boolean).map(line => {
			const [hash, subject, author, email, date] = line.split('|');
			const isAI = email?.includes('agent@vibeide') || subject?.includes('Co-authored-by: VibeIDE');
			const isAISubject = subject?.match(/^(feat|fix|chore|refactor|security).*VibeIDE/i);
			return { hash, subject, author, email, date, isAI: !!(isAI || isAISubject) };
		});
	} catch (e) {
		return [];
	}
}

function categorizeCommit(subject) {
	if (subject?.startsWith('feat')) return '✨ Features';
	if (subject?.startsWith('fix')) return '🐛 Bug Fixes';
	if (subject?.startsWith('security')) return '🔒 Security';
	if (subject?.startsWith('refactor')) return '♻️ Refactoring';
	if (subject?.startsWith('perf')) return '🚀 Performance';
	if (subject?.startsWith('docs')) return '📚 Documentation';
	if (subject?.startsWith('build') || subject?.startsWith('ci')) return '📦 Build & CI';
	return '🔧 Other Changes';
}

function generateMarkdown(commits) {
	const humanCommits = commits.filter(c => !c.isAI);
	const aiCommits = commits.filter(c => c.isAI);

	const sections = {};
	for (const commit of commits) {
		const cat = categorizeCommit(commit.subject);
		if (!sections[cat]) sections[cat] = [];
		sections[cat].push(commit);
	}

	let output = `# Changelog\n\n`;
	if (SINCE) output += `Changes since ${SINCE}\n\n`;
	output += `Generated: ${new Date().toISOString().split('T')[0]}\n\n`;
	output += `---\n\n`;

	for (const [category, catCommits] of Object.entries(sections)) {
		output += `## ${category}\n\n`;
		for (const c of catCommits) {
			const aiTag = c.isAI ? ' `[AI-assisted]`' : '';
			output += `- ${c.subject}${aiTag} (${c.date}, ${c.hash.slice(0, 7)})\n`;
		}
		output += '\n';
	}

	output += `---\n\n`;
	output += `**Summary:** ${commits.length} commits total — `;
	output += `${humanCommits.length} manual, ${aiCommits.length} AI-assisted\n`;

	return output;
}

// Main
const commits = getCommits(SINCE);

if (commits.length === 0) {
	console.log('No commits found.');
	process.exit(0);
}

if (FORMAT === 'json') {
	console.log(JSON.stringify(commits, null, 2));
} else {
	console.log(generateMarkdown(commits));
}
