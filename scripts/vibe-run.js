#!/usr/bin/env node
/**
 * vibe run — run VibeIDE agent from CLI (CI/CD integration)
 *
 * Usage:
 *   node scripts/vibe-run.js --auto "task description"
 *   node scripts/vibe-run.js --dry-run "task description"
 *   node scripts/vibe-run.js --no-local-constraints --auto "..."
 *
 * Phase 1: framework + dry-run simulation
 * Phase 2: actual agent execution via VibeIDE IPC
 */

'use strict';

const args = process.argv.slice(2);

const DRY_RUN = args.includes('--dry-run');
const AUTO = args.includes('--auto');
const NO_LOCAL_CONSTRAINTS = args.includes('--no-local-constraints');
const TASK = args.find(a => !a.startsWith('--')) || '';

if (!TASK) {
	console.log('Usage:');
	console.log('  vibe run --auto "<task>"          # run agent automatically');
	console.log('  vibe run --dry-run "<task>"       # show plan without executing');
	console.log('  vibe run --auto --no-local-constraints "<task>"  # skip .vibe/constraints.json (CI)');
	process.exit(0);
}

console.log(`\n🤖 VibeIDE Agent${DRY_RUN ? ' (dry-run)' : ''}\n${'─'.repeat(50)}`);
console.log(`Task: ${TASK}`);
console.log(`Mode: ${AUTO ? 'Auto' : 'Manual'}`);
if (NO_LOCAL_CONSTRAINTS) console.log(`Constraints: local constraints disabled`);
if (DRY_RUN) console.log(`Dry-run: will show plan without modifying files\n`);

if (DRY_RUN) {
	console.log('Pre-flight plan (simulated):');
	console.log('  1. Analyze task requirements');
	console.log('  2. Explore codebase (grep, git log)');
	console.log('  3. Identify files to modify');
	console.log('  4. Apply changes');
	console.log('  5. Run tests (if configured)');
	console.log('\n⚠️  Phase 1: dry-run shows simulated plan only.');
	console.log('   Phase 2: will execute via VibeIDE IPC with actual file analysis.');
	console.log('\n✅ No files modified (dry-run mode).');
	process.exit(0);
}

// Phase 1: framework placeholder
console.log('\n⚠️  Phase 1: vibe run --auto requires VibeIDE to be running.');
console.log('   Open VibeIDE, run the task in the chat, then use `vibe run --auto` for CI/CD.');
console.log('\n   Phase 2 will implement direct agent execution via IPC.');
console.log('   Track progress: https://github.com/VibeBrains/VibeIDE/milestone/2');
