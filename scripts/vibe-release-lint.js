#!/usr/bin/env node
/**
 * vibe release-lint — verify a GitHub Release notes body before publication.
 *
 * Checks (per CLAUDE.md release format):
 *   1. Title-line tag matches `vX.Y.Z` semver.
 *   2. Only allowed section headers with emoji are used.
 *   3. No empty sections.
 *   4. The "Поддержать проект" donation block is present at the very end.
 *   5. The donation block contains the QR <img> link.
 *
 * Usage:
 *   node scripts/vibe-release-lint.js path/to/release-notes.md
 *   node scripts/vibe-release-lint.js --stdin            # read from stdin
 *   node scripts/vibe-release-lint.js --tag v0.2.1 path/to/release-notes.md
 *
 * Exit codes:
 *   0 — clean
 *   1 — at least one error (printed to stderr)
 */

'use strict';

const fs = require('fs');

const ALLOWED_HEADERS = new Set([
	'## 🐛 Исправления',
	'## ✨ Новое',
	'## 🚀 Производительность',
	'## 🔒 Безопасность',
	'## ♻️ Внутреннее',
	'## 📦 Сборка',
]);

const QR_URL = 'https://raw.githubusercontent.com/borodatych/VSCodeSyncFiles/main/media/QR-Code.jpg';

const args = process.argv.slice(2);
let tag = null;
let stdin = false;
const positional = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--tag') {
		tag = args[++i];
	} else if (args[i] === '--stdin') {
		stdin = true;
	} else {
		positional.push(args[i]);
	}
}

function readNotes() {
	if (stdin) {
		return fs.readFileSync(0, 'utf-8');
	}
	const file = positional[0];
	if (!file) {
		console.error('Usage: vibe-release-lint.js <release-notes.md> | --stdin');
		process.exit(1);
	}
	return fs.readFileSync(file, 'utf-8');
}

/** @param {string} text @returns {string[]} errors */
function lint(text) {
	const errors = [];

	// Tag check (only when --tag passed)
	if (tag !== null) {
		if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
			errors.push(`Tag must match vX.Y.Z, got '${tag}'.`);
		}
	}

	const lines = text.split(/\r?\n/);

	// Allowed headers
	for (const line of lines) {
		if (line.startsWith('## ')) {
			if (line === '## Поддержать проект' || line === '### Поддержать проект') {
				continue; // donation block uses ### but the heading style is allowed
			}
			if (!ALLOWED_HEADERS.has(line)) {
				errors.push(`Unknown section header: '${line}'. Allowed: ${[...ALLOWED_HEADERS].join(', ')}.`);
			}
		}
	}

	// Empty sections — a header followed only by blanks until the next header / end
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith('## ')) {
			continue;
		}
		// look ahead for content
		let hasContent = false;
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].startsWith('## ')) {
				break;
			}
			if (lines[j].trim() !== '' && !lines[j].startsWith('---')) {
				hasContent = true;
				break;
			}
		}
		if (!hasContent && lines[i] !== '## Поддержать проект') {
			errors.push(`Empty section: '${lines[i]}'.`);
		}
	}

	// Donation block at the end
	const tail = text.trimEnd();
	if (!tail.includes('### Поддержать проект') && !tail.includes('## Поддержать проект')) {
		errors.push('Missing donation block "Поддержать проект" near the end of the notes.');
	}
	if (!tail.includes(QR_URL)) {
		errors.push(`Donation block missing the QR image URL ${QR_URL}.`);
	}
	// The donation block must come after every other section
	const lastDonationIdx = Math.max(
		text.lastIndexOf('### Поддержать проект'),
		text.lastIndexOf('## Поддержать проект'),
	);
	for (const h of ALLOWED_HEADERS) {
		const idx = text.lastIndexOf(h);
		if (idx > lastDonationIdx && lastDonationIdx >= 0) {
			errors.push(`Section '${h}' appears AFTER the donation block; donation block must be last.`);
		}
	}

	return errors;
}

function main() {
	const text = readNotes();
	const errors = lint(text);
	if (errors.length === 0) {
		console.log('vibe release-lint: ok');
		return;
	}
	console.error('vibe release-lint — issues:');
	for (const e of errors) {
		console.error(`  - ${e}`);
	}
	process.exit(1);
}

main();
