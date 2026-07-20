/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'child_process';
import { spawn } from 'cross-spawn';
// Added lines below
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// scope-tailwind invokes `tailwindcss` as a bare binary; ensure workspace node_modules/.bin with tailwind is on PATH (Windows CI/local).
(function prependTailwindBinToPath() {
	let dir = __dirname;
	for (;;) {
		const nmBin = path.join(dir, 'node_modules', '.bin');
		const twCmd = path.join(nmBin, 'tailwindcss.cmd');
		const twSh = path.join(nmBin, 'tailwindcss');
		if ((process.platform === 'win32' && fs.existsSync(twCmd)) || fs.existsSync(twSh)) {
			const sep = path.delimiter;
			process.env.PATH = `${nmBin}${sep}${process.env.PATH ?? ''}`;
			return;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return;
		}
		dir = parent;
	}
})();

function doesPathExist(filePath) {
	try {
		const stats = fs.statSync(filePath);

		return stats.isFile();
	} catch (err) {
		if (err.code === 'ENOENT') {
			return false;
		}
		throw err;
	}
}

/*

This function finds `globalDesiredPath` given `localDesiredPath` and `currentPath`

Diagram:

...basePath/
└── void/
	├── ...currentPath/ (defined globally)
	└── ...localDesiredPath/ (defined locally)

*/
function findDesiredPathFromLocalPath(localDesiredPath, currentPath) {

	// walk upwards until currentPath + localDesiredPath exists
	while (!doesPathExist(path.join(currentPath, localDesiredPath))) {
		const parentDir = path.dirname(currentPath);

		if (parentDir === currentPath) {
			return undefined;
		}

		currentPath = parentDir;
	}

	// return the `globallyDesiredPath`
	const globalDesiredPath = path.join(currentPath, localDesiredPath);
	return globalDesiredPath;
}

// hack to refresh styles automatically
function saveStylesFile() {
	setTimeout(() => {
		try {
			const pathToCssFile = findDesiredPathFromLocalPath('./src/vs/workbench/contrib/vibeide/browser/react/src2/styles.css', __dirname);

			if (pathToCssFile === undefined) {
				console.error('[scope-tailwind] Error finding styles.css');
				return;
			}

			// Or re-write with the same content:
			const content = fs.readFileSync(pathToCssFile, 'utf8');
			fs.writeFileSync(pathToCssFile, content, 'utf8');
			console.log('[scope-tailwind] Force-saved styles.css');
		} catch (err) {
			console.error('[scope-tailwind] Error saving styles.css:', err);
		}
	}, 6000);
}

/*
Emit lightweight `.d.ts` declarations next to each `out/<entry>/index.js` bundle.

Why: the workbench TypeScript sources import these bundles (e.g. `mountSidebar` from
`./react/out/sidebar-tsx/index.js`). `react/**` is excluded from `src/tsconfig.json`, and no
declarations are shipped, so with `allowJs` the type-checker (tsgo) has to parse each multi-MB
minified bundle to recover its exports. That parse is memory-hungry and, on memory-constrained CI
runners, degrades to "has no exported member" failures. Tiny hand-generated declarations make the
imports resolve against stable, cheap files instead of the bundle — no bundle parsing, no OOM.

The declarations are derived from the entry `src/<entry>/index.tsx` sources, so they never drift
from the actual exports: every `mountX = mountFnGenerator(...)` becomes a `VibeReactMountFn`, and any
plain `export { ... }` re-export is forwarded to its original module (which ships its own types).
*/
function generateDeclarations() {
	const srcDir = path.join(__dirname, 'src');
	const outDir = path.join(__dirname, 'out');

	// Shared mount signature — mirrors the return type of `util/mountFnGenerator`.
	const mountTypeHeader = [
		"import type { ServicesAccessor } from '../../../../../../../editor/browser/editorExtensions.js';",
		'type VibeReactMountResult = { rerender: (props?: any) => void; dispose: () => void };',
		'type VibeReactMountFn = (rootElement: HTMLElement, accessor: ServicesAccessor, props?: any) => VibeReactMountResult | undefined;',
	].join('\n');

	for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const indexTsx = path.join(srcDir, entry.name, 'index.tsx');
		const bundleJs = path.join(outDir, entry.name, 'index.js');
		if (!fs.existsSync(indexTsx) || !fs.existsSync(bundleJs)) {
			continue;
		}

		const source = fs.readFileSync(indexTsx, 'utf8');
		const mountNames = [...source.matchAll(/export\s+const\s+(\w+)\s*=\s*mountFnGenerator\(/g)].map(m => m[1]);

		// Forward plain re-exports (e.g. `export { diffLines, Change };`) to their source module,
		// which supplies its own declarations.
		const reexports = [];
		for (const match of source.matchAll(/export\s*\{([^}]+)\}\s*;/g)) {
			const names = match[1].split(',').map(n => n.trim()).filter(Boolean);
			for (const name of names) {
				const importMatch = source.match(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'([^']+)'`));
				if (importMatch) {
					reexports.push(`export { ${name} } from '${importMatch[1]}';`);
				}
			}
		}

		if (mountNames.length === 0 && reexports.length === 0) {
			continue;
		}

		const lines = [];
		if (mountNames.length > 0) {
			lines.push(mountTypeHeader);
			lines.push(...mountNames.map(name => `export declare const ${name}: VibeReactMountFn;`));
		}
		lines.push(...reexports);

		fs.writeFileSync(path.join(outDir, entry.name, 'index.d.ts'), lines.join('\n') + '\n', 'utf8');
	}
}

const args = process.argv.slice(2);
const isWatch = args.includes('--watch') || args.includes('-w');

if (isWatch) {
	// this just builds it if it doesn't exist instead of waiting for the watcher to trigger
	// Check if src2/ exists; if not, do an initial scope-tailwind build
	if (!fs.existsSync('src2')) {
		try {
			console.log('🔨 Running initial scope-tailwind build to create src2 folder...');
			execSync(
				'npx scope-tailwind ./src -o src2/ -s vibe-scope -c styles.css -p "vibe-"',
				{ stdio: 'inherit' }
			);
			console.log('✅ src2/ created successfully.');
		} catch (err) {
			console.error('❌ Error running initial scope-tailwind build:', err);
			process.exit(1);
		}
	}

	// Watch mode
	const scopeTailwindWatcher = spawn('npx', [
		'nodemon',
		'--watch', 'src',
		'--ext', 'ts,tsx,css',
		'--exec',
		'npx scope-tailwind ./src -o src2/ -s vibe-scope -c styles.css -p "vibe-"'
	]);

	const tsupWatcher = spawn('npx', [
		'tsup',
		'--watch'
	]);

	scopeTailwindWatcher.stdout.on('data', (data) => {
		console.log(`[scope-tailwind] ${data}`);
		// If the output mentions "styles.css", trigger the save:
		if (data.toString().includes('styles.css')) {
			saveStylesFile();
		}
	});

	scopeTailwindWatcher.stderr.on('data', (data) => {
		console.error(`[scope-tailwind] ${data}`);
	});

	// Handle tsup watcher output
	tsupWatcher.stdout.on('data', (data) => {
		console.log(`[tsup] ${data}`);
		// Refresh `.d.ts` shims after each successful rebuild so exports stay in sync.
		if (data.toString().includes('Build success')) {
			try {
				generateDeclarations();
			} catch (err) {
				console.error('[dts] Error generating declarations:', err);
			}
		}
	});

	tsupWatcher.stderr.on('data', (data) => {
		console.error(`[tsup] ${data}`);
	});

	// Handle process termination
	process.on('SIGINT', () => {
		scopeTailwindWatcher.kill();
		tsupWatcher.kill();
		process.exit();
	});

	console.log('🔄 Watchers started! Press Ctrl+C to stop both watchers.');
} else {
	// Build mode
	console.log('📦 Building...');

	// Run scope-tailwind once
	execSync('npx scope-tailwind ./src -o src2/ -s vibe-scope -c styles.css -p "vibe-"', { stdio: 'inherit' });

	// Run tsup once
	execSync('npx tsup', { stdio: 'inherit' });

	// Emit `.d.ts` shims so the workbench compile resolves against them, not the bundles.
	generateDeclarations();

	console.log('✅ Build complete!');
}
