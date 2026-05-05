#!/usr/bin/env node
/**
 * vibe schema templates — .vibe/schema/ community templates marketplace
 *
 * Usage:
 *   node scripts/vibe-schema-templates.js --list
 *   node scripts/vibe-schema-templates.js --install soc2
 *   node scripts/vibe-schema-templates.js --install https://example.com/my-template.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const INSTALL = args.find(a => a.startsWith('--install='))?.split('=')[1]
	|| (args.includes('--install') ? args[args.indexOf('--install') + 1] : null);

const WORKSPACE = process.cwd();

// Built-in community templates registry
const BUILT_IN_TEMPLATES = {
	'soc2': {
		description: 'SOC2 compliance constraints',
		url: 'built-in',
		tags: ['compliance', 'enterprise', 'security'],
	},
	'fastapi': {
		description: 'FastAPI Python backend',
		url: 'built-in',
		tags: ['python', 'backend', 'api'],
	},
	'nextjs': {
		description: 'Next.js React frontend',
		url: 'built-in',
		tags: ['react', 'typescript', 'frontend'],
	},
	'django': {
		description: 'Django web framework',
		url: 'built-in',
		tags: ['python', 'web', 'backend'],
	},
	'rust-cli': {
		description: 'Rust CLI application',
		url: 'built-in',
		tags: ['rust', 'cli', 'systems'],
	},
	'monorepo-pnpm': {
		description: 'pnpm monorepo constraints',
		url: 'built-in',
		tags: ['monorepo', 'pnpm', 'workspace'],
	},
};

if (LIST) {
	console.log('\n📋 Available .vibe/ community templates:\n');
	Object.entries(BUILT_IN_TEMPLATES).forEach(([name, t]) => {
		console.log(`  ${name.padEnd(20)} — ${t.description}`);
		console.log(`  ${''.padEnd(20)}   Tags: ${t.tags.join(', ')}\n`);
	});
	console.log('Install: node scripts/vibe-schema-templates.js --install <name>');
	console.log('Custom:  node scripts/vibe-schema-templates.js --install https://url/template.json');
	process.exit(0);
}

if (INSTALL) {
	const vibePath = path.join(WORKSPACE, '.vibe');
	const schemaPath = path.join(vibePath, 'schema');
	fs.mkdirSync(schemaPath, { recursive: true });

	// Check if it's a URL
	if (INSTALL.startsWith('https://') || INSTALL.startsWith('http://')) {
		console.log(`⚠️  Installing from URL: ${INSTALL}`);
		console.log('⚠️  Security: reviewing template before applying...');

		// Download and show diff before applying
		const url = new URL(INSTALL);
		const client = url.protocol === 'https:' ? https : require('http');

		client.get(INSTALL, res => {
			let data = '';
			res.on('data', d => data += d);
			res.on('end', () => {
				try {
					const template = JSON.parse(data);
					console.log('\nTemplate preview:');
					console.log(JSON.stringify(template, null, 2).slice(0, 500));
					console.log('\n[To apply: review above and run with --confirm flag]');
					console.log('SHA-256:', require('crypto').createHash('sha256').update(data).digest('hex'));
				} catch (e) {
					console.error('Invalid JSON template:', e.message);
				}
			});
		}).on('error', e => console.error('Download failed:', e.message));
	} else if (BUILT_IN_TEMPLATES[INSTALL]) {
		// Install built-in template by running workspace template script
		const { execSync } = require('child_process');
		console.log(`Installing template: ${INSTALL}\n`);
		execSync(`node scripts/vibe-workspace-template.js --template ${INSTALL}`, {
			stdio: 'inherit',
			cwd: WORKSPACE,
		});
	} else {
		console.error(`Template not found: ${INSTALL}`);
		console.log('Run --list to see available templates');
		process.exit(1);
	}
	process.exit(0);
}

console.log('Usage:\n  --list         Show available templates\n  --install <name|url>  Install a template');
