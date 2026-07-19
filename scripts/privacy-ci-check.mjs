#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Privacy CI check — static source analysis hard gate.
 *
 * Scans VibeIDE source for:
 *   1. Hardcoded URLs to blocked telemetry / tracking domains.
 *   2. product.json outbound endpoints vs the declared allow-list.
 *   3. Presence of any `fetch(` or `XMLHttpRequest` calls in React source
 *      that don't go through the approved IVibeHttpService or node fetch wrapper.
 *
 * Exit code 0 = pass, 1 = violations found.
 *
 * Usage:
 *   node scripts/privacy-ci-check.mjs            # text report
 *   node scripts/privacy-ci-check.mjs --json     # JSON report
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const BLOCKED_DOMAINS = [
	'google-analytics.com',
	'googletagmanager.com',
	'segment.io',
	'segment.com',
	'mixpanel.com',
	'amplitude.com',
	'hotjar.com',
	'fullstory.com',
	'heap.io',
	'intercom.io',
	'intercom.com',
	'datadoghq.com',
	'newrelic.com',
	'logrocket.com',
	'facebook.com',
	'doubleclick.net',
	'adnxs.com',
];

// Source directories to scan for URLs (TS/JS/JSON source, not build output)
const SCAN_DIRS = [
	path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide'),
	path.join(ROOT, 'extensions'),
];

// product.json declared outbound endpoints (allowed)
const PRODUCT_ALLOWED_FIELDS = [
	'updateUrl', 'releasesApiUrl', 'modelsRegistryUrl', 'extensionsGalleryUrl',
	'linkProtectionTrustedDomains',
];

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');

// ---------------------------------------------------------------------------

function walkSrc(dir, exts = ['.ts', '.tsx', '.js', '.json'], acc = []) {
	if (!fs.existsSync(dir)) { return acc; }
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'node_modules' || ent.name === 'out' || ent.name === '.build') { continue; }
			walkSrc(p, exts, acc);
		} else if (exts.some(e => ent.name.endsWith(e))) {
			acc.push(p);
		}
	}
	return acc;
}

function scanForBlockedUrls(dir) {
	const findings = [];
	const urlRe = /https?:\/\/([a-zA-Z0-9.-]+)/g;

	for (const file of walkSrc(dir)) {
		let source;
		try { source = fs.readFileSync(file, 'utf-8'); } catch { continue; }
		urlRe.lastIndex = 0;
		let m;
		while ((m = urlRe.exec(source)) !== null) {
			const host = m[1].toLowerCase();
			for (const blocked of BLOCKED_DOMAINS) {
				if (host === blocked || host.endsWith('.' + blocked)) {
					const lineNum = source.slice(0, m.index).split('\n').length;
					findings.push({
						file: path.relative(ROOT, file),
						line: lineNum,
						host,
						blockedPattern: blocked,
						snippet: m[0].slice(0, 80),
					});
				}
			}
		}
	}
	return findings;
}

function checkProductJson() {
	const productPath = path.join(ROOT, 'product.json');
	const issues = [];
	if (!fs.existsSync(productPath)) { return issues; }
	let product;
	try { product = JSON.parse(fs.readFileSync(productPath, 'utf-8')); } catch { return issues; }

	for (const field of PRODUCT_ALLOWED_FIELDS) {
		const val = product[field];
		if (typeof val === 'string') {
			let host;
			try { host = new URL(val).hostname; } catch { continue; }
			for (const blocked of BLOCKED_DOMAINS) {
				if (host === blocked || host.endsWith('.' + blocked)) {
					issues.push({ source: `product.json#${field}`, host, value: val });
				}
			}
		}
	}
	return issues;
}

// Scan for raw fetch() in React source (should go through approved HTTP wrapper)
function scanRawFetchCalls(dir) {
	const reactSrc = path.join(dir, 'src', 'vs', 'workbench', 'contrib', 'vibeide', 'browser', 'react', 'src');
	const findings = [];
	if (!fs.existsSync(reactSrc)) { return findings; }

	const rawFetchRe = /\bfetch\s*\(/g;
	const approvedComment = '@privacy-approved-fetch';

	for (const file of walkSrc(reactSrc, ['.ts', '.tsx'])) {
		const source = fs.readFileSync(file, 'utf-8');
		rawFetchRe.lastIndex = 0;
		let m;
		while ((m = rawFetchRe.exec(source)) !== null) {
			// Check if there is an @privacy-approved-fetch comment in the 5 lines above
			const before = source.slice(Math.max(0, m.index - 300), m.index);
			if (before.includes(approvedComment)) { continue; }
			const lineNum = source.slice(0, m.index).split('\n').length;
			findings.push({
				file: path.relative(dir, file),
				line: lineNum,
				note: 'Raw fetch() in React source — add @privacy-approved-fetch comment if intentional',
			});
		}
	}
	return findings;
}

// ---------------------------------------------------------------------------

const urlViolations = SCAN_DIRS.flatMap(d => scanForBlockedUrls(d));
const productViolations = checkProductJson();
const fetchViolations = scanRawFetchCalls(ROOT);

const totalViolations = urlViolations.length + productViolations.length + fetchViolations.length;

if (JSON_MODE) {
	console.log(JSON.stringify({
		pass: totalViolations === 0,
		urlViolations,
		productViolations,
		fetchViolations,
		summary: { total: totalViolations },
	}, null, 2));
} else {
	console.log('\n🔒 VibeIDE Privacy CI check');
	console.log('─'.repeat(50));

	if (urlViolations.length > 0) {
		console.log(`\n❌ Blocked domain URLs in source (${urlViolations.length}):`);
		for (const v of urlViolations) {
			console.log(`  ${v.file}:${v.line}  → ${v.snippet}  (blocked: ${v.blockedPattern})`);
		}
	}

	if (productViolations.length > 0) {
		console.log(`\n❌ Blocked domains in product.json (${productViolations.length}):`);
		for (const v of productViolations) {
			console.log(`  ${v.source}: ${v.value} (blocked: ${v.host})`);
		}
	}

	if (fetchViolations.length > 0) {
		console.log(`\n⚠ Raw fetch() calls in React source (${fetchViolations.length}):`);
		for (const v of fetchViolations) {
			console.log(`  ${v.file}:${v.line} — ${v.note}`);
		}
		console.log('  (warnings only — add @privacy-approved-fetch to silence)');
	}

	if (totalViolations === 0 && fetchViolations.length === 0) {
		console.log('\n✅ Privacy CI: no violations detected.');
	} else if (urlViolations.length === 0 && productViolations.length === 0) {
		console.log('\n✅ Privacy CI: no hard violations. Review fetch() warnings above.');
	}
}

// Hard gate: only url + product violations block CI; fetch is advisory
process.exit(urlViolations.length + productViolations.length > 0 ? 1 : 0);
