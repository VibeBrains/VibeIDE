#!/usr/bin/env node
/**
 * vibe i18n-migrate — find localize() / localize2() calls whose message argument is
 * Cyrillic and migrate them so the source carries an English placeholder while the
 * Cyrillic text moves into vibeide.nls.<locale>.json.
 *
 * Background: today many Russian strings are hardcoded in the **second** argument of
 * `localize(key, "русский текст")`. The VS Code NLS extractor expects English source +
 * a separate translation bundle. Without this migration the language-pack build cannot
 * run because extracting "english" from a Cyrillic source yields garbage.
 *
 * Usage:
 *   node scripts/vibe-i18n-migrate.js                                # dry-run report
 *   node scripts/vibe-i18n-migrate.js --apply                        # rewrite source files
 *   node scripts/vibe-i18n-migrate.js --apply --locale ru            # write to vibeide.nls.ru.json (default ru)
 *   node scripts/vibe-i18n-migrate.js --root src/vs/workbench/contrib/vibeide
 *   node scripts/vibe-i18n-migrate.js --json
 *
 * Output bundle path: out/nls/vibeide.nls.<locale>.json (created if missing).
 * The migration is idempotent: a second run finds no Cyrillic and exits clean.
 *
 * The English placeholder injected into the source is the original key humanised:
 * `localize('vibeFoo.bar', 'foo bar')`. A reviewer fixes the placeholder later or via
 * vibe-i18n-draft.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function value(name) {
	const idx = args.indexOf(name);
	if (idx < 0 || idx + 1 >= args.length) {
		const eq = args.find(a => a.startsWith(name + '='));
		return eq ? eq.slice(name.length + 1) : null;
	}
	return args[idx + 1];
}

const APPLY = flag('--apply');
const JSON_OUT = flag('--json');
const LOCALE = value('--locale') ?? 'ru';
const SCAN_ROOT = path.resolve(ROOT, value('--root') ?? 'src/vs/workbench/contrib/vibeide');

const BUNDLE_DIR = path.join(ROOT, 'out', 'nls');
const BUNDLE_FILE = path.join(BUNDLE_DIR, `vibeide.nls.${LOCALE}.json`);

const CYRILLIC = /[Ѐ-ӿ]/;

/** @param {string} dir @param {string[]} acc */
function walk(dir, acc = []) {
	if (!fs.existsSync(dir)) {
		return acc;
	}
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'node_modules' || ent.name === 'out' || ent.name === 'react') continue;
			walk(p, acc);
		} else if (/\.tsx?$/.test(ent.name)) {
			acc.push(p);
		}
	}
	return acc;
}

/**
 * Match `localize(...)` and `localize2(...)` calls with a string-literal key and a
 * string-literal message argument. Captures the entire call so we can identify whether
 * to rewrite or skip (we rewrite only when the message is Cyrillic).
 *
 * Captures:
 *   1: function name (localize / localize2)
 *   2: key (single or double quote contents)
 *   3: message (single or double quote contents)
 *   trailing — preserve whatever follows up to the matching close paren of the call.
 *
 * Limitation: this is a regex, not a TS parser. Multi-line arguments, template literals,
 * or computed keys are skipped (left as-is) — a follow-up pass with TS AST would catch
 * those.
 */
const CALL_REGEX = /\b(localize2?)\s*\(\s*(['"])((?:\\.|(?!\2).)*?)\2\s*,\s*(['"])((?:\\.|(?!\4).)*?)\4/g;

function humanizeKey(key) {
	// vibeFoo.bar → "Foo bar"
	const tail = key.split('.').slice(1).join('.') || key;
	return tail
		.replace(/[._-]+/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/^./, c => c.toUpperCase())
		.trim();
}

function readBundle() {
	try {
		return JSON.parse(fs.readFileSync(BUNDLE_FILE, 'utf-8'));
	} catch {
		return {};
	}
}

function writeBundle(bundle) {
	if (!fs.existsSync(BUNDLE_DIR)) {
		fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	}
	fs.writeFileSync(BUNDLE_FILE, JSON.stringify(bundle, null, '\t') + '\n');
}

function processFile(filePath, bundle) {
	const raw = fs.readFileSync(filePath, 'utf-8');
	let changed = false;
	let migrations = 0;
	const out = raw.replace(CALL_REGEX, (whole, fn, kq, key, mq, message) => {
		if (!CYRILLIC.test(message)) {
			return whole;
		}
		bundle[key] = message;
		const placeholder = humanizeKey(key);
		changed = true;
		migrations += 1;
		return `${fn}(${kq}${key}${kq}, ${mq}${placeholder.replace(new RegExp(mq, 'g'), '\\' + mq)}${mq}`;
	});
	return { changed, migrations, out };
}

function main() {
	const files = walk(SCAN_ROOT);
	const bundle = readBundle();
	const report = { scanned: files.length, withCyrillic: 0, totalMigrations: 0, files: [] };

	for (const file of files) {
		const { changed, migrations, out } = processFile(file, bundle);
		if (!changed) continue;
		report.withCyrillic += 1;
		report.totalMigrations += migrations;
		report.files.push({ file: path.relative(ROOT, file), migrations });
		if (APPLY) {
			fs.writeFileSync(file, out);
		}
	}

	if (APPLY) {
		writeBundle(bundle);
	}

	if (JSON_OUT) {
		process.stdout.write(JSON.stringify({
			...report,
			bundle: APPLY ? path.relative(ROOT, BUNDLE_FILE) : `(dry-run; would write ${path.relative(ROOT, BUNDLE_FILE)})`,
		}, null, 2) + '\n');
		return;
	}

	console.log(`vibe i18n-migrate (${APPLY ? 'apply' : 'dry-run'})`);
	console.log(`  scan root:    ${path.relative(ROOT, SCAN_ROOT)}`);
	console.log(`  bundle:       ${path.relative(ROOT, BUNDLE_FILE)}`);
	console.log(`  scanned:      ${report.scanned} TS files`);
	console.log(`  with cyril:   ${report.withCyrillic} files`);
	console.log(`  migrations:   ${report.totalMigrations} localize() calls`);
	if (report.totalMigrations > 0) {
		console.log('');
		for (const f of report.files.slice(0, 20)) {
			console.log(`    ${f.migrations.toString().padStart(3)}  ${f.file}`);
		}
		if (report.files.length > 20) {
			console.log(`    … ${report.files.length - 20} more`);
		}
	}
	if (!APPLY && report.totalMigrations > 0) {
		console.log('');
		console.log('Re-run with --apply to rewrite source files and update the bundle.');
	}
}

main();
