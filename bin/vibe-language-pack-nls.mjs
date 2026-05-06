#!/usr/bin/env node
/**
 * VibeIDE operator helper: Russian language pack + NLS metadata (dev).
 * Wraps repo scripts under scripts/ — single source of truth.
 *
 * Usage:
 *   node bin/vibe-language-pack-nls.mjs --help
 *   node bin/vibe-language-pack-nls.mjs verify
 *   node bin/vibe-language-pack-nls.mjs extract
 *   node bin/vibe-language-pack-nls.mjs sync-ru [--version 1.118.1]
 *   node bin/vibe-language-pack-nls.mjs clear-clp
 *
 * See: docs/knowledge.md → [i18n] Language pack (RU), NLS…
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function printHelp() {
	console.log(`VibeIDE language pack / NLS helper

Commands:
  verify     Compare sidebarPane nls.localize2 indices vs out/nls.messages.json
  extract    Run scripts/vibe-nls-extract.ts (same as npm run nls-extract)
  sync-ru    Run scripts/sync-vscode-loc-ru.mjs (pass --version if needed)
  clear-clp  Run scripts/vibe-dev-clear-nls-clp.mjs (dev profile clp cache)

Full playbook: docs/knowledge.md`);
}

function cmdVerify() {
	const messagesPath = path.join(ROOT, 'out', 'nls.messages.json');
	const sidebarPath = path.join(
		ROOT,
		'out',
		'vs',
		'workbench',
		'contrib',
		'vibeide',
		'browser',
		'sidebarPane.js'
	);
	if (!fs.existsSync(messagesPath)) {
		console.error('[vibe-lang] missing', messagesPath, '— run npm run compile first');
		process.exit(1);
	}
	if (!fs.existsSync(sidebarPath)) {
		console.error('[vibe-lang] missing', sidebarPath, '— run npm run compile first');
		process.exit(1);
	}
	const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
	const js = fs.readFileSync(sidebarPath, 'utf8');
	const mChat = js.match(/localize2\((\d+),\s*['"]Chat['"]\)/);
	const mEmpty = js.match(/localize2\((\d+),\s*['"]['"]\)/);
	if (!mChat || !mEmpty) {
		console.error('[vibe-lang] verify: could not parse localize2 indices from sidebarPane.js');
		process.exit(1);
	}
	const iChat = Number(mChat[1]);
	const iEmpty = Number(mEmpty[1]);
	const okChat = messages[iChat] === 'Chat';
	const okEmpty = messages[iEmpty] === '';
	console.log('[vibe-lang] indices: Chat →', iChat, ', empty →', iEmpty);
	if (okChat && okEmpty) {
		console.log('[vibe-lang] verify: OK (messages match embed indices)');
		return;
	}
	console.error('[vibe-lang] verify: FAIL');
	if (!okChat) {
		console.error(`  nls.messages.json[${iChat}] = ${JSON.stringify(messages[iChat])} (expected "Chat")`);
	}
	if (!okEmpty) {
		console.error(`  nls.messages.json[${iEmpty}] = ${JSON.stringify(messages[iEmpty])} (expected "")`);
	}
	console.error('  Fix: npm run nls-extract, clear dev clp, full Electron restart (see knowledge.md)');
	process.exit(1);
}

function cmdExtract() {
	const r = spawnSync('npx', ['tsx', 'scripts/vibe-nls-extract.ts'], {
		cwd: ROOT,
		stdio: 'inherit',
		shell: true,
	});
	process.exit(r.status ?? 1);
}

function cmdSyncRu(extra) {
	const r = spawnSync('node', ['scripts/sync-vscode-loc-ru.mjs', ...extra], {
		cwd: ROOT,
		stdio: 'inherit',
		shell: false,
	});
	process.exit(r.status ?? 1);
}

function cmdClearClp() {
	const r = spawnSync('node', ['scripts/vibe-dev-clear-nls-clp.mjs'], {
		cwd: ROOT,
		stdio: 'inherit',
		shell: false,
	});
	process.exit(r.status ?? 1);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

if (!cmd || cmd === '--help' || cmd === '-h') {
	printHelp();
	process.exit(0);
}

switch (cmd) {
	case 'verify':
		cmdVerify();
		break;
	case 'extract':
		cmdExtract();
		break;
	case 'sync-ru':
		cmdSyncRu(rest);
		break;
	case 'clear-clp':
		cmdClearClp();
		break;
	default:
		console.error('[vibe-lang] unknown command:', cmd);
		printHelp();
		process.exit(1);
}
