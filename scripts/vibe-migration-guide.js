#!/usr/bin/env node
/**
 * vibe migration guide — generate IDE migration docs
 * 
 * Usage:
 *   node scripts/vibe-migration-guide.js --from cursor
 *   node scripts/vibe-migration-guide.js --from windsurf
 *   node scripts/vibe-migration-guide.js --version-upgrade --from 0.1.0 --to 0.2.0
 */

'use strict';

const args = process.argv.slice(2);
const FROM = args.find(a => a.startsWith('--from='))?.split('=')[1]
	|| (args.includes('--from') ? args[args.indexOf('--from') + 1] : null);
const VERSION_UPGRADE = args.includes('--version-upgrade');
const FROM_VERSION = args.find(a => a.startsWith('--from-version='))?.split('=')[1] || '0.1.0';
const TO_VERSION = args.find(a => a.startsWith('--to-version='))?.split('=')[1] || 'latest';

function printCursorMigration() {
	console.log(`
# Cursor → VibeIDE Migration Guide

## Why migrate?
- No subscription required (bring your own API key)
- Full transparency: see exact prompts, context, cost
- Open-source: audit the code, not just trust it
- Works with local models (Ollama) — no internet required

## Step 1: Install VibeIDE
Download from: https://github.com/VibeIDETeam/VibeIDE/releases

## Step 2: Import settings
\`\`\`bash
# One command — converts .cursorrules, keybindings, and settings
npm run vibe:init:from -- --from cursor
\`\`\`

This converts:
- .cursorrules → .vibe/rules.md
- .cursor/rules/ → .vibe/rules.md
- Cursor keybindings → VibeIDE keybindings

## Step 3: Configure API keys
Same API keys work: Settings → VibeIDE → Providers

## Step 4: Learn key differences

| Cursor | VibeIDE |
|--------|---------|
| .cursorrules | .vibe/rules.md |
| AI features (subscription) | All features (BYOK) |
| Black box | Debug my prompt panel |
| No audit trail | .vibe/audit.jsonl |
| No rollback | Agent Action History + Snapshots |

## Extensions
VibeIDE uses Open VSX (~70% of VS Marketplace extensions).
Check compatibility: https://open-vsx.org

## Need help?
- GitHub Issues: https://github.com/VibeIDETeam/VibeIDE/issues
- Discord: [join link]
`);
}

function printVersionUpgrade(from, to) {
	console.log(`
# VibeIDE ${from} → ${to} Upgrade Guide

## Automatic migration
\`\`\`bash
node scripts/migrations/template.js --workspace /path/to/project
\`\`\`

## Breaking changes
Run \`npm run vibe:doctor\` to check for schema issues.

## .vibe/ format changes
If \`vibe doctor\` reports schema errors, the migration script will fix them.

## Data preserved
- .vibe/snapshots/ (rollback points)
- .vibe/audit.jsonl (audit history)
- .vibe/context.md (project brain)
- .vibe/constraints.json / rules.md / permissions.json
`);
}

if (VERSION_UPGRADE) {
	printVersionUpgrade(FROM_VERSION, TO_VERSION);
} else if (FROM === 'cursor' || FROM === 'windsurf' || FROM === 'continue' || FROM === 'aider') {
	if (FROM === 'cursor') {
		printCursorMigration();
	} else {
		console.log(`\nMigration from ${FROM}:\n\nnpm run vibe:init:from -- --from ${FROM}\n\nSee: https://github.com/VibeIDETeam/VibeIDE/blob/main/docs/CONTRIBUTING.md`);
	}
} else {
	console.log('Usage: node vibe-migration-guide.js --from cursor|windsurf|continue|aider');
	console.log('       node vibe-migration-guide.js --version-upgrade --from-version 0.1.0 --to-version 0.2.0');
}
