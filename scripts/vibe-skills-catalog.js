#!/usr/bin/env node
/**
 * Community Agent Skills catalog (CLI parity with IDE palette commands).
 * English header — project convention for scripts.
 *
 * Usage:
 *   node scripts/vibe-skills-catalog.js list <catalogUrl>
 *   node scripts/vibe-skills-catalog.js manifest <manifestUrl> [expectedSha256]
 */

'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const CATALOG_FORMAT = 'vibe-community-skills-catalog-v1';
const MANIFEST_FORMAT = 'vibe-community-skill-manifest-v1';

function fetchUrl(urlStr, redirectDepth = 5) {
	if (redirectDepth < 0) {
		return Promise.reject(new Error('too many redirects'));
	}
	return new Promise((resolve, reject) => {
		let u;
		try {
			u = new URL(urlStr);
		} catch (e) {
			reject(e);
			return;
		}
		const lib = u.protocol === 'https:' ? https : http;
		const req = lib.get(urlStr, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				const next = new URL(res.headers.location, urlStr).href;
				res.resume();
				fetchUrl(next, redirectDepth - 1).then(resolve).catch(reject);
				return;
			}
			if (res.statusCode !== 200) {
				reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
				res.resume();
				return;
			}
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		});
		req.on('error', reject);
	});
}

function sha256hex(s) {
	return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function parseCatalog(text) {
	let j;
	try {
		j = JSON.parse(text);
	} catch {
		throw new Error('catalog is not valid JSON');
	}
	if (!j || typeof j !== 'object' || j.format !== CATALOG_FORMAT) {
		throw new Error(`catalog missing format "${CATALOG_FORMAT}"`);
	}
	if (!Array.isArray(j.entries)) {
		throw new Error('catalog.entries must be an array');
	}
	return j.entries.map((e, i) => {
		if (!e || typeof e !== 'object') {
			throw new Error(`entries[${i}] invalid`);
		}
		if (typeof e.id !== 'string' || !e.id.trim()) {
			throw new Error(`entries[${i}].id required`);
		}
		if (typeof e.manifestUrl !== 'string' || !e.manifestUrl.trim()) {
			throw new Error(`entries[${i}].manifestUrl required`);
		}
		return {
			id: e.id.trim(),
			name: typeof e.name === 'string' ? e.name : '',
			manifestUrl: e.manifestUrl.trim(),
			sha256: typeof e.sha256 === 'string' ? e.sha256.trim() : '',
		};
	});
}

function parseManifest(text) {
	let j;
	try {
		j = JSON.parse(text);
	} catch {
		throw new Error('manifest is not valid JSON');
	}
	if (!j || typeof j !== 'object' || j.format !== MANIFEST_FORMAT) {
		throw new Error(`manifest missing format "${MANIFEST_FORMAT}"`);
	}
	if (typeof j.skillId !== 'string' || !j.skillId.trim()) {
		throw new Error('manifest.skillId required');
	}
	if (typeof j.skillMarkdown !== 'string' || !j.skillMarkdown.trim()) {
		throw new Error('manifest.skillMarkdown required');
	}
	return {
		skillId: j.skillId.trim(),
		skillMarkdown: j.skillMarkdown.replace(/\r\n/g, '\n'),
	};
}

async function cmdList(url) {
	const text = await fetchUrl(url);
	const entries = parseCatalog(text);
	for (const e of entries) {
		const pin = e.sha256 ? ` pin=${e.sha256.slice(0, 12)}…` : '';
		process.stdout.write(`${e.id}\t${e.name || '(no name)'}\t${e.manifestUrl}${pin}\n`);
	}
	process.stdout.write(`\nTotal: ${entries.length}\n`);
}

async function cmdManifest(url, expectedSha) {
	const text = await fetchUrl(url);
	const hex = sha256hex(text);
	if (expectedSha && expectedSha.toLowerCase() !== hex) {
		throw new Error(`SHA-256 mismatch: got ${hex}, expected ${expectedSha}`);
	}
	const m = parseManifest(text);
	process.stdout.write(`ok skillId=${m.skillId} sha256=${hex}\n`);
	process.stdout.write(`--- markdown (${m.skillMarkdown.length} chars) ---\n`);
	process.stdout.write(m.skillMarkdown);
	if (!m.skillMarkdown.endsWith('\n')) {
		process.stdout.write('\n');
	}
}

async function main() {
	const [cmd, url, expectedSha] = process.argv.slice(2);
	if (!cmd || cmd === '--help' || cmd === '-h') {
		process.stderr.write(`Usage:
  node scripts/vibe-skills-catalog.js list <catalogUrl>
  node scripts/vibe-skills-catalog.js manifest <manifestUrl> [expectedSha256]
`);
		process.exit(cmd ? 0 : 1);
		return;
	}
	if (!url) {
		throw new Error('URL argument required');
	}
	if (cmd === 'list') {
		await cmdList(url);
	} else if (cmd === 'manifest') {
		await cmdManifest(url, expectedSha);
	} else {
		throw new Error(`unknown command: ${cmd}`);
	}
}

main().catch((e) => {
	process.stderr.write(String(e.message || e) + '\n');
	process.exit(1);
});
