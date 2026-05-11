#!/usr/bin/env node
/**
 * vibe diff --split-commits — split a large diff into logical atomic commits
 *
 * Uses diffCommitGrouping (common/diffCommitGrouping.ts CJS mirror) for
 * Conventional-Commits-aware bucketing.
 *
 * Phase 2 (this file): Ollama-assisted commit-message body generation.
 *   When --ollama flag is passed and Ollama is running locally, each commit
 *   group gets an AI-generated body using the staged diff hunk as context.
 *   Falls back to renderGroupStub when Ollama is unavailable.
 *
 * Usage:
 *   node scripts/vibe-diff-split.js [--dry-run] [--json] [--ollama] [--model <name>]
 *   node scripts/vibe-diff-split.js --ollama --model qwen2.5-coder:3b
 */

'use strict';

const { execSync } = require('child_process');
const http = require('http');
const path = require('path');
const { groupDiffByCommitType, renderGroupStub } = require('./lib/diff-commit-grouping.cjs');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const JSON_OUTPUT = args.includes('--json');
const USE_OLLAMA = args.includes('--ollama');
const MODEL_IDX = args.indexOf('--model');
const OLLAMA_MODEL = MODEL_IDX !== -1 && args[MODEL_IDX + 1] ? args[MODEL_IDX + 1] : 'qwen2.5-coder:3b';
const OLLAMA_BASE = 'http://localhost:11434';

// ---------------------------------------------------------------------------
// Ollama helpers
// ---------------------------------------------------------------------------

function ollamaPost(path, body) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const opts = {
			hostname: 'localhost',
			port: 11434,
			path,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
		};
		const req = http.request(opts, res => {
			let out = '';
			res.on('data', chunk => { out += chunk; });
			res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ response: '' }); } });
		});
		req.on('error', reject);
		req.write(data);
		req.end();
	});
}

async function isOllamaRunning() {
	return new Promise(resolve => {
		const req = http.get(`${OLLAMA_BASE}/api/tags`, res => {
			resolve(res.statusCode === 200);
		});
		req.on('error', () => resolve(false));
		req.setTimeout(1500, () => { req.destroy(); resolve(false); });
	});
}

/**
 * Generate a conventional-commit message body for a group using Ollama.
 * Returns a 2-3 sentence string or falls back to empty string on error.
 */
async function ollamaCommitBody(groupLabel, filePaths, diffHunk) {
	const prompt = [
		`You are a Git commit message writer. Write a concise body (2-3 sentences, plain text, no bullet points)`,
		`for a "${groupLabel}" commit that touches these files:`,
		filePaths.slice(0, 10).join(', '),
		diffHunk ? `\nDiff excerpt:\n${diffHunk.slice(0, 800)}` : '',
		'\nBody only — no subject line, no prefix, no markdown:',
	].join('\n');

	try {
		const result = await ollamaPost('/api/generate', {
			model: OLLAMA_MODEL,
			prompt,
			stream: false,
			options: { temperature: 0.2, num_predict: 120 },
		});
		const body = (result.response || '').trim();
		return body.slice(0, 500);
	} catch {
		return '';
	}
}

function getStagedDiffHunk(files) {
	if (!files.length) { return ''; }
	try {
		const paths = files.slice(0, 5).map(f => `"${f.path}"`).join(' ');
		return execSync(`git diff --cached -- ${paths}`, { encoding: 'utf-8' }).slice(0, 2000);
	} catch { return ''; }
}

function getStagedFiles() {
	try {
		const result = execSync('git diff --cached --name-status', { encoding: 'utf-8' });
		return result.trim().split('\n').filter(Boolean).map(line => {
			const parts = line.split('\t');
			const status = (parts[0] || '').trim().toUpperCase();
			const filePath = parts[1] || '';
			return {
				path: filePath,
				isNew: status === 'A',
				isDeleted: status === 'D',
			};
		}).filter(f => f.path.length > 0);
	} catch { return []; }
}

const stagedChanges = getStagedFiles();

if (stagedChanges.length === 0) {
	console.log('No staged files. Run: git add <files>');
	process.exit(0);
}

if (stagedChanges.length <= 5 && !JSON_OUTPUT) {
	console.log(`${stagedChanges.length} files staged — no split needed.`);
	process.exit(0);
}

const groups = groupDiffByCommitType(stagedChanges);

async function main() {
	const ollamaAvailable = USE_OLLAMA && await isOllamaRunning();
	if (USE_OLLAMA && !ollamaAvailable) {
		console.warn(`⚠ Ollama not running at ${OLLAMA_BASE} — falling back to stub messages.`);
	}
	if (USE_OLLAMA && ollamaAvailable) {
		console.log(`🤖 Ollama available (${OLLAMA_MODEL}) — generating AI commit bodies...`);
	}

	// Build enriched group list (with optional AI body)
	const enriched = [];
	for (const group of groups) {
		const stub = renderGroupStub(group);
		let body = '';
		if (ollamaAvailable) {
			const hunk = getStagedDiffHunk(group.files);
			body = await ollamaCommitBody(stub, group.files.map(f => f.path), hunk);
		}
		enriched.push({ group, stub, body });
	}

	if (JSON_OUTPUT) {
		const out = enriched.map(({ group, stub, body }) => ({
			commitMessage: stub,
			commitBody: body || undefined,
			type: group.type,
			scope: group.scope,
			files: group.files.map(f => f.path),
		}));
		console.log(JSON.stringify(out, null, 2));
		process.exit(0);
	}

	console.log(`\nvibe diff --split-commits\n${'─'.repeat(50)}`);
	console.log(`${stagedChanges.length} staged files → ${groups.length} logical commits\n`);

	enriched.forEach(({ group, stub, body }, i) => {
		console.log(`Commit ${i + 1}: ${stub}`);
		if (body) {
			console.log(`\n  ${body.replace(/\n/g, '\n  ')}\n`);
		}
		group.files.forEach(f => console.log(`  - ${f.path}`));
		console.log('');
	});

	if (DRY_RUN) {
		console.log('[dry-run] No commits made.');
		process.exit(0);
	}

	console.log('Note: unstage all, then stage and commit each group manually.');
	console.log('Or use: git add -p (interactive staging)');
	if (!USE_OLLAMA) {
		console.log('Tip: add --ollama to generate AI-assisted commit bodies via Ollama.');
	}
}

main().catch(err => {
	console.error('vibe-diff-split error:', err.message);
	process.exit(1);
});
