#!/usr/bin/env node
/**
 * vibe explain — explain code, diffs, or branches in plain language
 *
 * Usage:
 *   node scripts/vibe-explain.js <file>:<line>
 *   node scripts/vibe-explain.js --diff [branch1..branch2]
 *   node scripts/vibe-explain.js --non-technical
 *   node scripts/vibe-explain.js --as-pr-description
 *   node scripts/vibe-explain.js --to-test
 *
 * Note: Phase 1 produces structured output for LLM processing.
 *       Phase 2 will call VibeIDE LLM API directly.
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

const MODE = {
	diff: args.includes('--diff'),
	nonTechnical: args.includes('--non-technical'),
	asPrDescription: args.includes('--as-pr-description'),
	toTest: args.includes('--to-test'),
	forReview: args.includes('--for-review'),
};

function getGitDiff(range) {
	try {
		return execSync(`git diff ${range || 'HEAD~1..HEAD'}`, { encoding: 'utf-8', timeout: 10000 });
	} catch (e) {
		return execSync('git diff --cached', { encoding: 'utf-8', timeout: 10000 });
	}
}

function getFileContent(filePath, line) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`File not found: ${filePath}`);
	}
	const content = fs.readFileSync(filePath, 'utf-8');
	const lines = content.split('\n');
	const lineNum = parseInt(line);
	const context = lines.slice(Math.max(0, lineNum - 5), lineNum + 5);
	return {
		file: filePath,
		line: lineNum,
		content: context.join('\n'),
		language: path.extname(filePath).slice(1) || 'text',
	};
}

function formatForLLM(prompt) {
	// Phase 1: output structured prompt that can be piped to any LLM
	// Phase 2: call VibeIDE LLM API directly
	console.log('=' .repeat(60));
	console.log('VIBE EXPLAIN — structured prompt for LLM');
	console.log('=' .repeat(60));
	console.log(prompt);
	console.log('=' .repeat(60));
	console.log('\n💡 Phase 1: pipe this to your preferred LLM or use in VibeIDE chat.');
	console.log('   Phase 2 will call VibeIDE LLM API directly.');
}

// Main
if (MODE.diff || MODE.asPrDescription || MODE.forReview) {
	const range = args.find(a => !a.startsWith('--') && !['node', 'vibe-explain.js'].includes(a));
	const diff = getGitDiff(range);
	
	let prompt;
	if (MODE.asPrDescription) {
		prompt = `Generate a PR description for the following diff.\nInclude: what changed, why, and any breaking changes.\nFormat as GitHub markdown PR description.\n\nDiff:\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``;
	} else if (MODE.forReview) {
		prompt = `Generate code review notes for each changed function in this diff.\nFormat as GitHub inline review comments.\nFocus on: bugs, security issues, performance, readability.\n\nDiff:\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``;
	} else if (MODE.nonTechnical) {
		prompt = `Explain what changed in this diff in plain English for a non-technical stakeholder.\nAvoid technical jargon. Focus on business impact.\n\nDiff:\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``;
	} else {
		prompt = `Explain what changed in this diff:\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``;
	}
	
	formatForLLM(prompt);
} else if (MODE.toTest) {
	const fileArg = args.find(a => !a.startsWith('--'));
	if (!fileArg) { console.error('Usage: vibe explain --to-test <file>:<line>'); process.exit(1); }
	const [file, line] = fileArg.split(':');
	const { content, language } = getFileContent(file, line || '1');
	formatForLLM(`Generate test cases for the following ${language} code.\nInclude: happy path, edge cases, error cases.\n\nCode:\n\`\`\`${language}\n${content}\n\`\`\``);
} else {
	// File:line explanation
	const fileArg = args.find(a => !a.startsWith('--') && a.includes(':'));
	if (!fileArg) {
		console.log('Usage: node vibe-explain.js <file>:<line>\n       node vibe-explain.js --diff [range]\n       node vibe-explain.js --as-pr-description\n       node vibe-explain.js --to-test <file>:<line>');
		process.exit(0);
	}
	const [file, line] = fileArg.split(':');
	const { content, language, file: resolvedFile, line: resolvedLine } = getFileContent(file, line || '1');
	formatForLLM(`Explain line ${resolvedLine} of ${resolvedFile} in the context of this code:\n\`\`\`${language}\n${content}\n\`\`\`\nBe concise: 1-3 sentences.`);
}
