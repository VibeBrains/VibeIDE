#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Всё, что мы засевали раньше и больше не засеваем, обязано уметь исчезнуть у пользователя —
 * если он этот файл не правил.
 *
 * Сеялка удаляет устаревший сид из `.vibe` проекта, ТОЛЬКО если sha256 копии совпадает с одной из
 * версий, перечисленных в `deprecated.json` набора. Не перечислили версию — файл той версии
 * останется у людей навсегда, и заметно это не станет никому: ни ошибки, ни падающего теста.
 * Договорённость «не забудь дописать хеши» — ровно тот вид соглашения, который протухает молча
 * (так в общем наборе уже сломалась цена под `cost*`), поэтому она стала гейтом.
 *
 * WHY two snapshots of the GENERATED manifest instead of walking git history: this repository's
 * local clone is shallow, and so are CI checkouts (fetch-depth 1 in several workflows). A history
 * walk over a truncated clone reports «nothing missing» about a comparison it never made — the
 * first manual coverage check of 2026-09-11 got the right answer only because the truncation
 * boundary happened to predate the seeds. The manifest at the base revision is what the last build
 * shipped; the manifest in the working tree is what the next one will ship. Both always exist.
 *
 * Invariant: for every path seeded at base and not seeded now, the new deprecated list carries
 * every sha256 the base build could have left on a user's disk — the shipped contents themselves
 * plus the history recorded for that path. Paths that left because they are now addressed to
 * another product are exempt: addressing means «do not seed», not «delete».
 *
 * Usage: node scripts/vibe-deprecated-coverage.ts [--base <git-ref>] [--base-file <path>]
 * Default base is HEAD, which is exactly right in a pre-commit hook. Positional arguments (the
 * staged paths lint-staged appends) are ignored.
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const cp: typeof import('child_process') = require('child_process');
const crypto: typeof import('crypto') = require('crypto');

const ROOT = path.join(__dirname, '..');
const MANIFEST_REL = 'src/vs/workbench/contrib/vibeide/common/vibeDefaultsManifest.generated.ts';

interface ManifestSnapshot {
	readonly productId: string;
	/** path → shipped contents */
	readonly seeded: ReadonlyMap<string, string>;
	/** path → every sha256 the set lists for deletion */
	readonly deprecated: ReadonlyMap<string, readonly string[]>;
	/** path → current sha256 plus recorded history */
	readonly versions: ReadonlyMap<string, readonly string[]>;
	/** paths addressed to other products only */
	readonly addressedAway: ReadonlySet<string>;
}

// One entry per line, values produced by JSON.stringify in scripts/gen-vibe-defaults.mjs — a JSON
// string literal is matched as `"` + (non-quote-non-backslash | escape)* + `"` and then JSON.parse'd.
const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"';
const JSON_ARRAY = '\\[[^\\]]*\\]';
const SEED_LINE = new RegExp(`^\\t\\{ path: (${JSON_STRING}), contents: (${JSON_STRING}) \\},$`);
const DEPRECATED_LINE = new RegExp(`^\\t\\{ path: (${JSON_STRING}), replacedBy: (?:null|${JSON_STRING}), sha256: (${JSON_ARRAY}) \\},$`);
const VERSION_LINE = new RegExp(`^\\t\\{ path: (${JSON_STRING}), version: \\d+, sha256: (${JSON_STRING}), history: (${JSON_ARRAY}) \\},$`);
const ADDRESS_LINE = new RegExp(`^\\t\\{ path: (${JSON_STRING}), products: (${JSON_ARRAY}) \\},$`);
const PRODUCT_LINE = new RegExp(`^export const VIBE_PRODUCT_ID = (${JSON_STRING});$`);

/** Lines between `export const <name>` and the closing `];` of that array. */
function sectionLines(lines: readonly string[], name: string): string[] {
	const start = lines.findIndex(line => line.startsWith(`export const ${name}`));
	if (start < 0) {
		return [];
	}
	const out: string[] = [];
	for (let i = start + 1; i < lines.length && lines[i] !== '];'; i++) {
		out.push(lines[i]);
	}
	return out;
}

function parseManifest(text: string, label: string): ManifestSnapshot {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const seeded = new Map<string, string>();
	for (const line of sectionLines(lines, 'VIBE_DEFAULTS_MANIFEST')) {
		const m = SEED_LINE.exec(line);
		if (m) { seeded.set(JSON.parse(m[1]), JSON.parse(m[2])); }
	}
	const deprecated = new Map<string, readonly string[]>();
	for (const line of sectionLines(lines, 'VIBE_DEPRECATED_MANIFEST')) {
		const m = DEPRECATED_LINE.exec(line);
		if (m) { deprecated.set(JSON.parse(m[1]), JSON.parse(m[2])); }
	}
	const versions = new Map<string, readonly string[]>();
	for (const line of sectionLines(lines, 'VIBE_VERSIONS_MANIFEST')) {
		const m = VERSION_LINE.exec(line);
		if (m) { versions.set(JSON.parse(m[1]), [JSON.parse(m[2]), ...JSON.parse(m[3])]); }
	}
	let productId = '';
	for (const line of lines) {
		const m = PRODUCT_LINE.exec(line);
		if (m) { productId = JSON.parse(m[1]); break; }
	}
	const addressedAway = new Set<string>();
	for (const line of sectionLines(lines, 'VIBE_FILE_ADDRESSING')) {
		const m = ADDRESS_LINE.exec(line);
		if (m && productId && !(JSON.parse(m[2]) as string[]).includes(productId)) {
			addressedAway.add(JSON.parse(m[1]));
		}
	}
	// A gate that recognises nothing must not report success: an empty parse means the generator's
	// format moved, and «0 files removed» would then be a claim about a comparison never made.
	if (seeded.size === 0) {
		fail(`${label}: в манифесте не распознано ни одной записи засева — формат генератора изменился, гейт его не узнаёт.`);
	}
	return { productId, seeded, deprecated, versions, addressedAway };
}

function sha256(text: string): string {
	// The set's hashes are taken over LF text; the generator already normalised CRLF on the way in.
	return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function fail(message: string): never {
	console.error(`\n❌ ${message}`);
	process.exit(1);
}

function readBase(args: readonly string[]): { text: string; label: string } {
	const fileAt = args.indexOf('--base-file');
	if (fileAt >= 0 && args[fileAt + 1]) {
		const file = args[fileAt + 1];
		return { text: fs.readFileSync(file, 'utf8'), label: file };
	}
	const refAt = args.indexOf('--base');
	const ref = refAt >= 0 && args[refAt + 1] ? args[refAt + 1] : 'HEAD';
	try {
		const text = cp.execFileSync('git', ['show', `${ref}:${MANIFEST_REL}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
		return { text, label: ref };
	} catch {
		// No base means nothing to compare against — say so, never pass silently.
		return fail(`не удалось прочитать манифест на ревизии «${ref}» — сравнивать не с чем.`);
	}
}

const args = process.argv.slice(2);
const base = readBase(args);
const before = parseManifest(base.text, `база ${base.label}`);
const after = parseManifest(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'), 'рабочая копия');

console.log('🧹 Покрытие устаревших сидов: убранное из засева обязано удаляться у пользователей');
console.log('─'.repeat(60));
console.log(`база: ${base.label} · засевалось ${before.seeded.size} · засевается ${after.seeded.size}`);

const removed = [...before.seeded.keys()].filter(p => !after.seeded.has(p) && !after.addressedAway.has(p));
if (removed.length === 0) {
	console.log('\n✅ Из засева ничего не убрано — проверять нечего.');
	process.exit(0);
}

const problems: string[] = [];
for (const file of removed) {
	const required = new Set<string>([sha256(before.seeded.get(file)!), ...(before.versions.get(file) ?? [])]);
	const listed = after.deprecated.get(file);
	if (!listed) {
		problems.push(`${file}: убран из засева, но не записан в deprecated.json — у пользователей он останется навсегда.`);
		continue;
	}
	const missing = [...required].filter(hash => !listed.includes(hash));
	if (missing.length > 0) {
		problems.push(`${file}: в deprecated.json нет ${missing.length} из ${required.size} известных версий — копии этих версий у пользователей не удалятся.`);
	} else {
		console.log(`   ✓ ${file} — все ${required.size} версий перечислены`);
	}
}

if (problems.length > 0) {
	console.log(`\n❌ Убрано из засева без возможности удалить у пользователей: ${problems.length}`);
	for (const problem of problems) {
		console.log(`   ${problem}`);
	}
	console.log('\nЛечится в наборе VibeBrains: запись в deprecated.json со всеми sha256 прошлых версий файла, затем `node bump.mjs`.');
	process.exit(1);
}
console.log(`\n✅ Проверено убранных из засева: ${removed.length}, все удаляемы у пользователей, не правивших их.`);
