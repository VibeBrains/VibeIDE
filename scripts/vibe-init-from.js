#!/usr/bin/env node
/**
 * vibe init --from cursor|windsurf|continue|aider|jetbrains
 * Converts settings from other IDEs/tools to .vibe/ format.
 *
 * Usage:
 *   node scripts/vibe-init-from.js --from cursor [--workspace /path]
 *   node scripts/vibe-init-from.js --from continue
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const FROM = args.find(a => a.startsWith('--from='))?.split('=')[1]
	|| (args.includes('--from') ? args[args.indexOf('--from') + 1] : null);
const WORKSPACE = args.find(a => a.startsWith('--workspace='))?.split('=')[1]
	|| (args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : null)
	|| process.cwd();

if (!FROM) {
	console.error('Usage: node vibe-init-from.js --from cursor|windsurf|continue|aider|jetbrains');
	process.exit(1);
}

// Secret detection — basic patterns to warn on
const SECRET_PATTERNS = [
	/sk-[A-Za-z0-9]{20,}/,    // OpenAI keys
	/sk-ant-[A-Za-z0-9-]{20,}/, // Anthropic keys
	/AIza[A-Za-z0-9-_]{35}/,  // Google API keys
	/ghp_[A-Za-z0-9]{36}/,    // GitHub tokens
	/[A-Za-z0-9-_]{32,}==/,   // Base64 tokens
];

function detectSecrets(text) {
	return SECRET_PATTERNS.some(p => p.test(text));
}

function redactSecrets(text) {
	let result = text;
	SECRET_PATTERNS.forEach(p => {
		result = result.replace(p, '[REDACTED]');
	});
	return result;
}

function ensureVibeDir(workspacePath) {
	const vibePath = path.join(workspacePath, '.vibe');
	if (!fs.existsSync(vibePath)) {
		fs.mkdirSync(vibePath, { recursive: true });
		console.log(`Created .vibe/ directory`);
	}
	return vibePath;
}

function writeVibeFile(vibePath, fileName, content) {
	const filePath = path.join(vibePath, fileName);
	if (fs.existsSync(filePath)) {
		console.log(`⚠️  ${fileName} already exists — skipping (delete manually to overwrite)`);
		return;
	}
	fs.writeFileSync(filePath, content);
	console.log(`✅ Created .vibe/${fileName}`);
}

// ──────────────────────────────────────────────────────
// CURSOR import
// ──────────────────────────────────────────────────────
function fromCursor(workspacePath, vibePath) {
	console.log('\n📂 Importing from Cursor...\n');

	// .cursorrules → .vibe/rules.md
	const cursorRules = path.join(workspacePath, '.cursorrules');
	if (fs.existsSync(cursorRules)) {
		let content = fs.readFileSync(cursorRules, 'utf-8');
		if (detectSecrets(content)) {
			console.warn('⚠️  Potential secrets detected in .cursorrules — redacting...');
			content = redactSecrets(content);
		}
		writeVibeFile(vibePath, 'rules.md',
			`# Project AI Rules\n\n<!-- Imported from .cursorrules -->\n<!-- vibeVersion: 1.0.0 -->\n\n${content}\n`);
	}

	// .cursor/rules/*.mdc → .vibe/rules.md (appended)
	const cursorRulesDir = path.join(workspacePath, '.cursor', 'rules');
	if (fs.existsSync(cursorRulesDir)) {
		const mdcFiles = fs.readdirSync(cursorRulesDir).filter(f => f.endsWith('.mdc') || f.endsWith('.md'));
		if (mdcFiles.length > 0) {
			const allRules = mdcFiles.map(f => {
				let content = fs.readFileSync(path.join(cursorRulesDir, f), 'utf-8');
				if (detectSecrets(content)) {
					console.warn(`⚠️  Potential secrets in .cursor/rules/${f} — redacting...`);
					content = redactSecrets(content);
				}
				return `## From ${f}\n\n${content}`;
			}).join('\n\n---\n\n');
			writeVibeFile(vibePath, 'rules.md',
				`# Project AI Rules\n\n<!-- Imported from .cursor/rules/ -->\n<!-- vibeVersion: 1.0.0 -->\n\n${allRules}\n`);
		}
	}

	console.log('\nCursor import complete. Review .vibe/rules.md for any remaining sensitive data.');
}

// ──────────────────────────────────────────────────────
// CONTINUE.DEV import
// ──────────────────────────────────────────────────────
function fromContinue(workspacePath, vibePath) {
	console.log('\n📂 Importing from Continue.dev...\n');

	const configPaths = [
		path.join(workspacePath, '.continue', 'config.json'),
		path.join(process.env.HOME || process.env.USERPROFILE || '', '.continue', 'config.json'),
	];

	let configPath = configPaths.find(p => fs.existsSync(p));
	if (!configPath) {
		console.error('No Continue.dev config.json found. Looked in:', configPaths.join(', '));
		return;
	}

	try {
		const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

		// Extract models → .vibe/allowed-models.json
		if (config.models?.length > 0) {
			const models = config.models.map(m => m.model || m.title || m.name).filter(Boolean);
			const allowedModels = { vibeVersion: '1.0.0', models, _comment: 'Imported from Continue.dev config' };
			writeVibeFile(vibePath, 'allowed-models.json', JSON.stringify(allowedModels, null, '\t') + '\n');
		}

		// Extract custom system messages → .vibe/rules.md
		if (config.systemMessage || config.customCommands?.length > 0) {
			let rulesContent = `# Project AI Rules\n\n<!-- Imported from Continue.dev config -->\n<!-- vibeVersion: 1.0.0 -->\n\n`;
			if (config.systemMessage) {
				rulesContent += `## System Message\n\n${config.systemMessage}\n\n`;
			}
			if (config.customCommands?.length > 0) {
				rulesContent += `## Custom Commands\n\n`;
				config.customCommands.forEach(cmd => {
					rulesContent += `### /${cmd.name}\n${cmd.description || ''}\n\n${cmd.prompt || ''}\n\n`;
				});
			}
			writeVibeFile(vibePath, 'rules.md', rulesContent);
		}

		console.log(`\nContinue.dev import complete. Imported from: ${configPath}`);
	} catch (e) {
		console.error('Failed to parse Continue.dev config.json:', e.message);
	}
}

// ──────────────────────────────────────────────────────
// WINDSURF import
// ──────────────────────────────────────────────────────
function fromWindsurf(workspacePath, vibePath) {
	console.log('\n📂 Importing from Windsurf...\n');

	// .windsurfrules → .vibe/rules.md
	const windsurfRules = path.join(workspacePath, '.windsurfrules');
	if (fs.existsSync(windsurfRules)) {
		let content = fs.readFileSync(windsurfRules, 'utf-8');
		if (detectSecrets(content)) {
			console.warn('⚠️  Potential secrets in .windsurfrules — redacting...');
			content = redactSecrets(content);
		}
		writeVibeFile(vibePath, 'rules.md',
			`# Project AI Rules\n\n<!-- Imported from .windsurfrules -->\n<!-- vibeVersion: 1.0.0 -->\n\n${content}\n`);
	} else {
		console.log('No .windsurfrules found in workspace.');
	}
}

// ──────────────────────────────────────────────────────
// AIDER import
// ──────────────────────────────────────────────────────
function fromAider(workspacePath, vibePath) {
	console.log('\n📂 Importing from Aider...\n');

	const aiderFiles = ['.aider.conf.yml', '.aiderignore', 'CONVENTIONS.md'];
	for (const f of aiderFiles) {
		const filePath = path.join(workspacePath, f);
		if (fs.existsSync(filePath)) {
			let content = fs.readFileSync(filePath, 'utf-8');
			if (detectSecrets(content)) {
				console.warn(`⚠️  Potential secrets in ${f} — redacting...`);
				content = redactSecrets(content);
			}
			if (f === '.aiderignore') {
				writeVibeFile(vibePath, 'ignore', content);
			} else {
				writeVibeFile(vibePath, 'rules.md',
					`# Project AI Rules\n\n<!-- Imported from ${f} -->\n<!-- vibeVersion: 1.0.0 -->\n\n${content}\n`);
			}
		}
	}
}

// ──────────────────────────────────────────────────────
// JETBRAINS import
// ──────────────────────────────────────────────────────
function fromJetBrains(workspacePath, vibePath) {
	console.log('\n📂 Importing from JetBrains...\n');
	console.log('⚠️  JetBrains import: automatic keymaps/live templates conversion is complex.');
	console.log('Currently supported: .idea/.editorconfig → .vibe/rules.md basics\n');

	const editorConfig = path.join(workspacePath, '.editorconfig');
	if (fs.existsSync(editorConfig)) {
		const content = fs.readFileSync(editorConfig, 'utf-8');
		writeVibeFile(vibePath, 'rules.md',
			`# Project AI Rules\n\n<!-- Imported from JetBrains project -->\n<!-- vibeVersion: 1.0.0 -->\n\n## Editor Config\n\nSee .editorconfig for code style settings.\n\n`);
	}

	console.log('For full JetBrains keymap migration: Settings → Keymap → Export → import manually.');
}

// ──────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────
const vibePath = ensureVibeDir(WORKSPACE);

switch (FROM.toLowerCase()) {
	case 'cursor': fromCursor(WORKSPACE, vibePath); break;
	case 'continue': fromContinue(WORKSPACE, vibePath); break;
	case 'windsurf': fromWindsurf(WORKSPACE, vibePath); break;
	case 'aider': fromAider(WORKSPACE, vibePath); break;
	case 'jetbrains': fromJetBrains(WORKSPACE, vibePath); break;
	default:
		console.error(`Unknown source: ${FROM}. Supported: cursor, windsurf, continue, aider, jetbrains`);
		process.exit(1);
}
