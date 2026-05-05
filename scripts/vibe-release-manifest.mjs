#!/usr/bin/env node
/**
 * CI: build release-manifest.json + checksums-sha256.txt from downloaded release-artifacts/.
 * Stable primary installer per OS/arch for in-app updater (see vibeideUpdateMainService).
 *
 * Usage:
 *   node scripts/vibe-release-manifest.mjs --root release-artifacts --tag v0.1.0 [--extra sbom.json] [--extra transparency.json]
 */

import { createReadStream } from 'fs';
import { readdir, stat, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { basename, join, relative } from 'path';
import { argv } from 'process';

function argValue(name) {
	const i = argv.indexOf(name);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const extras = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--extra' && argv[i + 1]) {
		extras.push(argv[i + 1]);
		i++;
	}
}

const tag = argValue('--tag') || process.env.VIBE_VERSION || '';
const root = argValue('--root') || 'release-artifacts';

if (!tag) {
	console.error('vibe-release-manifest: missing --tag or VIBE_VERSION');
	process.exit(1);
}

const version = /^v\d/i.test(tag) ? tag.slice(1) : tag;

/** @param {string} filePath */
function sha256Stream(filePath) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const s = createReadStream(filePath);
		s.on('data', (c) => hash.update(c));
		s.on('end', () => resolve(hash.digest('hex')));
		s.on('error', reject);
	});
}

/** @param {string} dir */
async function walkFiles(dir) {
	const out = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			out.push(...await walkFiles(p));
		} else if (e.isFile()) {
			out.push(p);
		}
	}
	return out;
}

/**
 * @param {string[]} files
 * @param {(f: string) => boolean} pred
 */
function pickFirst(files, pred) {
	const m = files.filter(pred).sort();
	return m[0] ?? null;
}

/** @param {string} sub */
async function listUnder(sub) {
	const p = join(root, sub);
	try {
		const st = await stat(p);
		if (!st.isDirectory()) {
			return [];
		}
		return walkFiles(p);
	} catch {
		return [];
	}
}

const winX64 = await listUnder('windows-x64');
const winArm = await listUnder('windows-arm64');
const mac = await listUnder('macos-universal');
const lnxX64 = await listUnder('linux-x64');
const lnxArm = await listUnder('linux-arm64');

const w64 = pickFirst(winX64, (f) => /\.exe$/i.test(f) && /setup/i.test(basename(f)));
const wa64 = pickFirst(winArm, (f) => /\.exe$/i.test(f) && /setup/i.test(basename(f)));
const dmg = pickFirst(mac, (f) => f.endsWith('.dmg'));
const lxDeb = pickFirst(lnxX64, (f) => f.endsWith('.deb'));
const laDeb = pickFirst(lnxArm, (f) => f.endsWith('.deb'));

/** @type {Array<[string, string]>} */
const picks = [];
if (w64) {
	picks.push(['win32-x64', w64]);
}
if (wa64) {
	picks.push(['win32-arm64', wa64]);
}
if (dmg) {
	picks.push(['darwin-universal', dmg]);
}
if (lxDeb) {
	picks.push(['linux-x64', lxDeb]);
}
if (laDeb) {
	picks.push(['linux-arm64', laDeb]);
}

// Resolve extra paths to absolute existing files
const extraAbs = [];
for (const e of extras) {
	const ap = join(process.cwd(), e);
	try {
		const st = await stat(ap);
		if (st.isFile()) {
			extraAbs.push(ap);
		}
	} catch { /* skip */ }
}

const allForChecksum = [...new Set([...winX64, ...winArm, ...mac, ...lnxX64, ...lnxArm, ...extraAbs])];

/** @type {Record<string, { basename: string, sha256: string }>} */
const assetEntries = {};
for (const [key, abs] of picks) {
	const b = basename(abs);
	const sha = await sha256Stream(abs);
	assetEntries[key] = { basename: b, sha256: sha };
}

const manifest = {
	schemaVersion: 1,
	tag_name: tag.startsWith('v') ? tag : `v${tag}`,
	version,
	generatedAt: new Date().toISOString(),
	assets: assetEntries,
};

const manifestPath = join(process.cwd(), 'release-manifest.json');
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const allForChecksumFinal = [...allForChecksum, manifestPath];

const lines = [];
for (const abs of allForChecksumFinal.sort()) {
	const hex = await sha256Stream(abs);
	const rel = relative(process.cwd(), abs).split('\\').join('/');
	lines.push(`${hex}  ${rel}`);
}

const checksumPath = join(process.cwd(), 'checksums-sha256.txt');
await writeFile(checksumPath, `${lines.join('\n')}\n`, 'utf8');

console.log('vibe-release-manifest:', manifestPath, checksumPath);
console.log('primary keys:', Object.keys(assetEntries).join(', ') || '(none)');
