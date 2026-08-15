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

// Third-party analytics and tracking.
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

/**
 * Vendor endpoints inherited from the VS Code upstream (telemetry, Copilot entitlement,
 * cloud dictation, surveys). They are not third-party trackers, but they are exactly what
 * an upstream base update silently re-introduces, so they are blocked in OUR code and in
 * product.json — with an explicit, reviewed allow-list below for the ones we do use.
 */
const BLOCKED_VENDOR_HOSTS = [
	'api.github.com',
	'githubcopilot.com',
	'copilot-proxy.githubusercontent.com',
	'mai.microsoft.com',
	'events.data.microsoft.com',
	'dc.services.visualstudio.com',
	'vortex.data.microsoft.com',
	'mobile.events.data.microsoft.com',
];

/**
 * Vendor hosts we deliberately keep, with the reason. Anything outside this list is a finding.
 * `api.github.com` is allowed only where we talk to OUR releases API (update check).
 */
const VENDOR_ALLOW = [
	{ host: 'api.github.com', file: /vibeide[\\/]common[\\/]outboundAllowlist\.ts$/, why: 'сам список разрешённых исходящих: манифест наших релизов' },
	{ host: 'api.github.com', file: /vibeide[\\/]common[\\/]vibeJobPRCompletionService\.ts$/, why: 'создание PR в репозитории пользователя по его команде' },
	{ host: 'api.github.com', file: /vibeide[\\/].*(update|release)/i, why: 'проверка обновлений в нашем репозитории релизов' },
];

// Source directories to scan for URLs (TS/JS/JSON source, not build output).
// Whole `src/` and `build/` are scanned: the upstream base is where vendor endpoints appear.
const SCAN_DIRS = [
	path.join(ROOT, 'src'),
	path.join(ROOT, 'build'),
	path.join(ROOT, 'extensions'),
	path.join(ROOT, 'scripts'),
];

// Directory names skipped everywhere during the scan (build output and bundled artifacts).
const SKIP_DIRS = new Set(['node_modules', 'out', 'out-build', 'out-vscode', 'out-vscode-min', '.build', 'dist', 'src2', 'test', 'fixtures']);

/**
 * Our own code: a vendor endpoint here is a hard failure — we wrote it.
 * Everything else is inherited upstream: those endpoints are tracked against a baseline
 * instead of failing the build, so the gate stays honest rather than permanently red
 * (a permanently red gate gets switched off, and then it protects nothing).
 */
const OURS_RE = /^(src[\\/]vs[\\/]workbench[\\/]contrib[\\/]vibeide[\\/]|src[\\/]vs[\\/]platform[\\/]vibe|extensions[\\/]vibe|scripts[\\/]vibe|build[\\/](gulpfile\.vibeide|lib[\\/]vibeide))/;

const BASELINE_PATH = path.join(ROOT, 'build', 'vendorEndpointsBaseline.json');

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
			if (SKIP_DIRS.has(ent.name)) { continue; }
			walkSrc(p, exts, acc);
		} else if (exts.some(e => ent.name.endsWith(e))) {
			acc.push(p);
		}
	}
	return acc;
}

function matchesHost(host, pattern) {
	return host === pattern || host.endsWith('.' + pattern);
}

/** A vendor host is excused only in the files listed in VENDOR_ALLOW. */
function vendorExcused(host, relFile) {
	return VENDOR_ALLOW.some(a => matchesHost(host, a.host) && a.file.test(relFile));
}

function scanForBlockedUrls(dir) {
	const findings = [];
	const urlRe = /https?:\/\/([a-zA-Z0-9.-]+)/g;

	for (const file of walkSrc(dir)) {
		let source;
		try { source = fs.readFileSync(file, 'utf-8'); } catch { continue; }
		const rel = path.relative(ROOT, file);
		urlRe.lastIndex = 0;
		let m;
		while ((m = urlRe.exec(source)) !== null) {
			const host = m[1].toLowerCase();
			const blocked = BLOCKED_DOMAINS.find(b => matchesHost(host, b));
			const vendor = BLOCKED_VENDOR_HOSTS.find(v => matchesHost(host, v));
			if (!blocked && !vendor) { continue; }
			if (vendor && vendorExcused(host, rel)) { continue; }
			const lineNum = source.slice(0, m.index).split('\n').length;
			const ours = OURS_RE.test(rel);
			findings.push({
				file: rel,
				line: lineNum,
				host,
				// tracker → always hard; vendor → hard in our code, baseline-tracked upstream
				kind: blocked ? 'tracker' : (ours ? 'vendor-ours' : 'vendor-upstream'),
				blockedPattern: blocked ?? vendor,
				snippet: m[0].slice(0, 80),
			});
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

	// Walk EVERY value recursively: vendor endpoints hide in nested blocks
	// (`defaultChatAgent.entitlementUrl`, `voiceWsUrl`, ...), not only in the fields we declared.
	const walkValues = (node, trail) => {
		if (typeof node === 'string') {
			const urlRe = /(?:https?|wss?):\/\/([a-zA-Z0-9.-]+)/g;
			let m;
			while ((m = urlRe.exec(node)) !== null) {
				const host = m[1].toLowerCase();
				const blocked = BLOCKED_DOMAINS.find(b => matchesHost(host, b));
				const vendor = BLOCKED_VENDOR_HOSTS.find(v => matchesHost(host, v));
				if (!blocked && !vendor) { continue; }
				if (PRODUCT_ALLOWED_FIELDS.includes(trail.split('.')[0]) && !vendor) { continue; }
				issues.push({ source: `product.json#${trail}`, host, kind: blocked ? 'tracker' : 'vendor', value: node.slice(0, 120) });
			}
			return;
		}
		if (Array.isArray(node)) {
			node.forEach((v, i) => walkValues(v, `${trail}[${i}]`));
			return;
		}
		if (node && typeof node === 'object') {
			for (const [k, v] of Object.entries(node)) {
				walkValues(v, trail ? `${trail}.${k}` : k);
			}
		}
	};
	walkValues(product, '');
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

const allUrlFindings = SCAN_DIRS.flatMap(d => scanForBlockedUrls(d));
// Hard: trackers anywhere + vendor endpoints in our own code.
const urlViolations = allUrlFindings.filter(f => f.kind !== 'vendor-upstream');
// Baseline-tracked: vendor endpoints inherited from upstream. Growth is the signal to review.
const upstreamVendor = allUrlFindings.filter(f => f.kind === 'vendor-upstream');
const productViolations = checkProductJson();
const fetchViolations = scanRawFetchCalls(ROOT);

/** Compare the upstream vendor inventory against the recorded baseline. */
function checkVendorBaseline(current) {
	const key = f => `${f.file}#${f.host}`;
	const currentKeys = [...new Set(current.map(key))].sort();
	if (process.argv.includes('--update-baseline')) {
		fs.writeFileSync(BASELINE_PATH, JSON.stringify({
			note: 'Инвентарь вендорных эндпоинтов, унаследованных от базы VS Code. Растёт при обновлении базы — каждая новая строка требует решения: вырезать, заглушить или принять.',
			entries: currentKeys,
		}, null, '\t') + '\n');
		return { added: [], removed: [], updated: true };
	}
	if (!fs.existsSync(BASELINE_PATH)) { return { added: [], removed: [], missing: true }; }
	const baseline = new Set(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')).entries ?? []);
	return {
		added: currentKeys.filter(k => !baseline.has(k)),
		removed: [...baseline].filter(k => !currentKeys.includes(k)),
	};
}

const vendorBaseline = checkVendorBaseline(upstreamVendor);
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

	console.log(`\nℹ Вендорные эндпоинты, унаследованные от базы VS Code: ${upstreamVendor.length} (базлайн)`);
	if (vendorBaseline.updated) {
		console.log(`  базлайн перезаписан: ${path.relative(ROOT, BASELINE_PATH)}`);
	} else if (vendorBaseline.missing) {
		console.log('  ⚠ файла базлайна нет — создайте его: node scripts/privacy-ci-check.mjs --update-baseline');
	} else {
		if (vendorBaseline.added.length > 0) {
			console.log(`  ❌ НОВЫЕ вендорные эндпоинты (${vendorBaseline.added.length}) — требуют решения:`);
			for (const a of vendorBaseline.added.slice(0, 25)) { console.log(`     + ${a}`); }
		}
		if (vendorBaseline.removed.length > 0) {
			console.log(`  ✅ исчезли из кода (${vendorBaseline.removed.length}) — обновите базлайн`);
		}
		if (vendorBaseline.added.length === 0 && vendorBaseline.removed.length === 0) {
			console.log('  без изменений против базлайна');
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

// Hard gate: trackers + vendor endpoints in our own code + product.json + new upstream
// vendor endpoints versus the baseline. Raw fetch() stays advisory.
const hardFailures = urlViolations.length + productViolations.length + (vendorBaseline.added?.length ?? 0);
process.exit(hardFailures > 0 ? 1 : 0);
