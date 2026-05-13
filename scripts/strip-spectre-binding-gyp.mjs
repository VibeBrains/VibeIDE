#!/usr/bin/env node
/**
 * Removes or downgrades SpectreMitigation in binding.gyp for curated native deps so
 * MSBuild does not require optional "Spectre-mitigated" MSVC libraries (MSB8040).
 *
 * Replacing patch-package diffs avoids Linux CI failures: npm ships these files
 * with CRLF; unified patches generated as LF often do not apply with GNU patch.
 *
 * Usage: node scripts/strip-spectre-binding-gyp.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
	'node_modules/@vscode/deviceid/binding.gyp',
	'node_modules/@vscode/spdlog/binding.gyp',
	'node_modules/@vscode/windows-mutex/binding.gyp',
	'node_modules/native-keymap/binding.gyp',
	// Required so `npm rebuild @vscode/windows-ca-certs` does not hit MSB8040
	// (Spectre-mitigated MSVC libs are an optional VS component, often absent).
	// Without crypt32.node, @vscode/proxy-agent cannot load Windows CA roots
	// and undici-fetch fails any TLS handshake on locked-down corp networks.
	'node_modules/@vscode/windows-ca-certs/binding.gyp',
];

/**
 * @param {string} content
 * @returns {string}
 */
function stripSpectreBlocks(content) {
	let out = content;
	// Double-quoted keys (e.g. @vscode/deviceid)
	const dq =
		/\r?\n[\t ]*"msvs_configuration_attributes"\s*:\s*\{\s*\r?\n[\t ]*"SpectreMitigation"\s*:\s*"Spectre"\s*\r?\n[\t ]*\},?\s*/g;
	// Single-quoted keys (spdlog, windows-mutex, native-keymap)
	const sq =
		/\r?\n[\t ]*'msvs_configuration_attributes'\s*:\s*\{\s*\r?\n[\t ]*'SpectreMitigation'\s*:\s*'Spectre'\s*\r?\n[\t ]*\},?\s*/g;
	out = out.replace(dq, '\n');
	out = out.replace(sq, '\n');
	return out;
}

/**
 * MSB8040 requires "Spectre-mitigated" MSVC libs when mitigation is on by default.
 * Pinning false avoids needing optional VS components (same intent as stripping "Spectre").
 * @param {string} content
 * @returns {string}
 */
function ensureSpectreMitigationFalseOnWin(content) {
	if (/SpectreMitigation\s*:\s*['"]false['"]/.test(content)) {
		return content;
	}
	const inject =
		'\n          "msvs_configuration_attributes": {\n            "SpectreMitigation": "false"\n          },';
	const re = /(\['OS=="win"',\s*\{)/;
	if (!re.test(content)) {
		return content;
	}
	return content.replace(re, `$1${inject}`);
}

let changed = 0;
for (const rel of TARGETS) {
	const filePath = path.join(root, rel);
	if (!fs.existsSync(filePath)) {
		continue;
	}
	const before = fs.readFileSync(filePath, 'utf8');
	const after = ensureSpectreMitigationFalseOnWin(stripSpectreBlocks(before));
	if (after !== before) {
		fs.writeFileSync(filePath, after, 'utf8');
		changed++;
		console.log('[strip-spectre-binding-gyp]', 'updated', rel);
	}
}

if (changed === 0) {
	console.log('[strip-spectre-binding-gyp]', 'nothing to update (skipped or already stripped)');
}
