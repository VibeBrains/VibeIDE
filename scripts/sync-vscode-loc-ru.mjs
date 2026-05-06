#!/usr/bin/env node
/**
 * Re-integrate the full Russian language pack from Open VSX (MS-CEINTL).
 * Replaces extensions/vscode-language-pack-ru/ with the official VSIX contents
 * (all translation bundles + package.json), not only main.i18n.json.
 *
 * Usage:
 *   node scripts/sync-vscode-loc-ru.mjs
 *   node scripts/sync-vscode-loc-ru.mjs --version 1.118.1
 *
 * Requires: dependency `yauzl` (root devDependency).
 */
import {
	cpSync,
	createWriteStream,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const targetExt = path.join(root, 'extensions/vscode-language-pack-ru');
const VIBE_NOTE =
	'Language pack extension for Russian (bundled in VibeIDE; upstream VSIX from Open VSX / vscode-loc).';

function readRootVersion() {
	const pj = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
	return String(pj.version || '').trim();
}

function parseArgs() {
	const a = process.argv.slice(2);
	let version = '';
	for (let i = 0; i < a.length; i++) {
		if (a[i] === '--version' && a[i + 1]) {
			version = a[i + 1];
			i++;
		}
	}
	return { version };
}

/**
 * @param {string} vsixPath
 * @param {string} outDir
 */
async function extractVsix(vsixPath, outDir) {
	await new Promise((resolve, reject) => {
		yauzl.open(vsixPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
			if (err) {
				reject(err);
				return;
			}
			if (!zipfile) {
				reject(new Error('open vsix: no zipfile'));
				return;
			}
			zipfile.readEntry();
			zipfile.on('entry', (entry) => {
				if (/\/$/.test(entry.fileName)) {
					zipfile.readEntry();
					return;
				}
				zipfile.openReadStream(entry, (e2, readStream) => {
					if (e2) {
						reject(e2);
						return;
					}
					const dest = path.join(outDir, entry.fileName);
					mkdirSync(path.dirname(dest), { recursive: true });
					const ws = createWriteStream(dest);
					const done = () => zipfile.readEntry();
					ws.on('error', reject);
					readStream.on('error', reject);
					pipeline(readStream, ws).then(done, reject);
				});
			});
			zipfile.on('end', resolve);
			zipfile.on('error', reject);
		});
	});
}

function patchDescription() {
	const pjPath = path.join(targetExt, 'package.json');
	const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
	pj.description = VIBE_NOTE;
	writeFileSync(pjPath, JSON.stringify(pj, null, '\t') + '\n', 'utf8');
}

async function main() {
	let { version } = parseArgs();
	if (!version) {
		version = readRootVersion();
	}
	if (!/^\d+\.\d+\.\d+/.test(version)) {
		console.error('Bad version; pass --version X.Y.Z or fix root package.json version.');
		process.exit(1);
	}

	const fileName = `MS-CEINTL.vscode-language-pack-ru-${version}.vsix`;
	const vsixUrl = `https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-ru/${version}/file/${fileName}`;

	console.log(`Downloading ${vsixUrl} …`);
	const res = await fetch(vsixUrl);
	if (!res.ok) {
		console.error(`HTTP ${res.status} ${res.statusText} — check version matches Open VSX (e.g. ${version}).`);
		process.exit(1);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	const work = path.join(tmpdir(), `vibeide-lp-ru-${version}-${process.pid}`);
	const vsixPath = path.join(work, fileName);
	const extractRoot = path.join(work, 'extract');
	mkdirSync(work, { recursive: true });
	writeFileSync(vsixPath, buf);
	console.log(`Extracting VSIX (${buf.length} bytes) …`);
	await extractVsix(vsixPath, extractRoot);

	const inner = path.join(extractRoot, 'extension');
	try {
		readFileSync(path.join(inner, 'package.json'));
	} catch {
		console.error('VSIX has no extension/package.json — unexpected layout.');
		process.exit(1);
	}

	console.log(`Replacing ${path.relative(root, targetExt)} …`);
	rmSync(targetExt, { recursive: true, force: true });
	mkdirSync(path.dirname(targetExt), { recursive: true });
	cpSync(inner, targetExt, { recursive: true });
	patchDescription();
	rmSync(work, { recursive: true, force: true });
	console.log('Done. Full language pack re-integrated. Clear %APPDATA%\\...\\vibeide*-dev\\clp\\ if UI strings look wrong; full restart Electron.');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
