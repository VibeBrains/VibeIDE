#!/usr/bin/env node
/**
 * vibe review — AI code review of a branch
 *
 * Usage:
 *   node scripts/vibe-review.js [branch]
 *   node scripts/vibe-review.js --output sarif
 *
 * Phase 1: structured prompt output + basic SARIF template
 * Phase 2: actual LLM-powered review with inline comments
 */

'use strict';

const { execSync } = require('child_process');
const args = process.argv.slice(2);
const OUTPUT_SARIF = args.includes('--output') && args[args.indexOf('--output') + 1] === 'sarif';
const BRANCH = args.find(a => !a.startsWith('--')) || 'HEAD';

function getDiff(branch) {
	try {
		const base = execSync(`git merge-base main ${branch} 2>/dev/null || git merge-base master ${branch}`, { encoding: 'utf-8' }).trim();
		return execSync(`git diff ${base}..${branch} --stat`, { encoding: 'utf-8', timeout: 10000 });
	} catch {
		return execSync('git diff --cached --stat', { encoding: 'utf-8', timeout: 10000 });
	}
}

function generateSARIF(findings) {
	return JSON.stringify({
		'$schema': 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
		version: '2.1.0',
		runs: [{
			tool: {
				driver: {
					name: 'vibe-review',
					version: '0.1.0',
					informationUri: 'https://github.com/VibeIDETeam/VibeIDE',
					rules: findings.map(f => ({ id: f.ruleId, name: f.ruleId, shortDescription: { text: f.message } }))
				}
			},
			results: findings.map(f => ({
				ruleId: f.ruleId,
				level: f.level || 'warning',
				message: { text: f.message },
				locations: f.location ? [{ physicalLocation: { artifactLocation: { uri: f.location.file }, region: { startLine: f.location.line } } }] : [],
			}))
		}]
	}, null, 2);
}

// Basic heuristic findings from diff
function analyzeForReview(diff) {
	const findings = [];
	const lines = diff.split('\n');

	for (const line of lines) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			if (/console\.log|console\.error/.test(line)) {
				findings.push({ ruleId: 'no-console', level: 'note', message: 'console.log detected — remove before merging' });
			}
			if (/TODO|FIXME|HACK/.test(line)) {
				findings.push({ ruleId: 'no-todo', level: 'note', message: `${line.match(/TODO|FIXME|HACK/)?.[0]} comment detected` });
			}
			if (/password|secret|api.?key|token/i.test(line) && !/test|mock|dummy|example/i.test(line)) {
				findings.push({ ruleId: 'potential-secret', level: 'error', message: 'Potential hardcoded secret detected' });
			}
		}
	}

	return findings;
}

// Main
const diff = getDiff(BRANCH);
const findings = analyzeForReview(diff);

if (OUTPUT_SARIF) {
	console.log(generateSARIF(findings));
} else {
	console.log(`\n📋 vibe review — ${BRANCH}\n${'─'.repeat(40)}`);
	console.log(`Diff summary:\n${diff.trim()}\n`);
	
	if (findings.length > 0) {
		console.log(`Findings (${findings.length}):`);
		findings.forEach(f => console.log(`  [${f.level}] ${f.ruleId}: ${f.message}`));
	} else {
		console.log('✅ No automatic findings detected.');
	}
	
	console.log('\n💡 Phase 1: basic heuristic review. Phase 2 will add LLM-powered inline comments.');
}
