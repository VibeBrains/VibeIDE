#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CI helper invoked by .github/workflows/i18n-bundle-version.yml on PRs that
// touch `product.json` or `extensions/vibeide-language-pack-*/package.json`.
// Compares each language-pack bundle version with the IDE's `vibeVersion`
// (single source of truth) and fails the job on any mismatch.
//
// MUST stay in sync with src/vs/workbench/contrib/vibeide/common/i18nBundleVersionCheck.ts
// (checkBundleVersionSync + describeBundleVersionVerdict semantics).

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function checkBundleVersionSync(input) {
	if (input.ideVersion === undefined || input.ideVersion === null) {
		return { kind: 'invalid-input', reason: 'ide-missing' };
	}
	if (input.bundleVersion === undefined || input.bundleVersion === null) {
		return { kind: 'invalid-input', reason: 'bundle-missing' };
	}
	if (typeof input.ideVersion !== 'string') {
		return { kind: 'invalid-input', reason: 'ide-not-string' };
	}
	if (typeof input.bundleVersion !== 'string') {
		return { kind: 'invalid-input', reason: 'bundle-not-string' };
	}
	const ide = input.ideVersion.trim();
	const bundle = input.bundleVersion.trim();
	if (ide.length === 0) return { kind: 'invalid-input', reason: 'ide-malformed' };
	if (bundle.length === 0) return { kind: 'invalid-input', reason: 'bundle-malformed' };

	if (ide === bundle) {
		return { kind: 'in-sync', version: ide };
	}

	const ideParts = SEMVER_PATTERN.exec(ide);
	const bundleParts = SEMVER_PATTERN.exec(bundle);
	if (!ideParts || !bundleParts) {
		return { kind: 'mismatch', ideVersion: ide, bundleVersion: bundle, drift: 'unparseable' };
	}

	const [, iMajor, iMinor] = ideParts;
	const [, bMajor, bMinor] = bundleParts;
	let drift;
	if (iMajor !== bMajor) drift = 'major';
	else if (iMinor !== bMinor) drift = 'minor';
	else drift = 'patch';

	return { kind: 'mismatch', ideVersion: ide, bundleVersion: bundle, drift };
}

export function describeBundleVersionVerdict(v) {
	switch (v.kind) {
		case 'in-sync':
			return `OK Language-pack bundle in sync with product.json:vibeVersion (${v.version}).`;
		case 'invalid-input':
			return `FAIL Bundle version check: invalid input — ${v.reason}.`;
		case 'mismatch':
			return `FAIL Language-pack bundle version mismatch — IDE \`${v.ideVersion}\` ≠ bundle \`${v.bundleVersion}\` (drift: ${v.drift}). Rebuild language pack via \`npm run build-language-packs\` against the current product.json.`;
		default:
			return `FAIL Bundle version check: unknown verdict shape.`;
	}
}

export function findLanguagePackPackageJsons(extensionsDir) {
	if (!existsSync(extensionsDir) || !statSync(extensionsDir).isDirectory()) {
		return [];
	}
	const out = [];
	for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith('vibeide-language-pack-')) continue;
		const pkg = join(extensionsDir, entry.name, 'package.json');
		if (existsSync(pkg)) {
			out.push(pkg);
		}
	}
	return out.sort();
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function emitWarning(filePath, message) {
	// GitHub Actions PR annotation. Two-space indent inside the message keeps
	// the multi-line text readable in the run summary.
	const oneLine = String(message).replace(/\r?\n/g, ' ');
	console.log(`::warning file=${filePath}::${oneLine}`);
}

function main() {
	const repoRoot = process.cwd();
	const productPath = join(repoRoot, 'product.json');
	if (!existsSync(productPath)) {
		console.error(`product.json not found at ${productPath}`);
		process.exit(2);
	}
	const product = readJson(productPath);
	const ideVersion = product?.vibeVersion;

	const bundles = findLanguagePackPackageJsons(join(repoRoot, 'extensions'));
	if (bundles.length === 0) {
		console.log('[skipped: no extensions/vibeide-language-pack-* bundles yet]');
		return;
	}

	let failed = 0;
	for (const pkgPath of bundles) {
		let bundleVersion;
		try {
			bundleVersion = readJson(pkgPath)?.version;
		} catch (e) {
			emitWarning(pkgPath.split(sep).join('/'), `Failed to parse ${pkgPath}: ${e.message}`);
			failed++;
			continue;
		}
		const verdict = checkBundleVersionSync({ ideVersion, bundleVersion });
		const description = describeBundleVersionVerdict(verdict);
		const annotationPath = pkgPath.split(sep).join('/');
		if (verdict.kind === 'in-sync') {
			console.log(`${annotationPath}: ${description}`);
		} else {
			emitWarning(annotationPath, description);
			console.log(`${annotationPath}: ${description}`);
			failed++;
		}
	}

	if (failed > 0) {
		console.error(`\n${failed} bundle(s) failed version sync check.`);
		process.exit(1);
	}
	console.log(`\nAll ${bundles.length} bundle(s) in sync with product.json:vibeVersion.`);
}

const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
	|| import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '');
if (isMain) {
	main();
}
