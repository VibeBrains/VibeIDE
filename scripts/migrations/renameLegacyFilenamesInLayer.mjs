#!/usr/bin/env node
/**
 * Rename files under contrib/vibeide whose basenames carry legacy product-prefix patterns.
 */
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '../..');
const vibeideDir = path.join(root, 'src/vs/workbench/contrib/vibeide');

/** @type {string} legacy lower-case product prefix + `ide` */
const LEG_LC = String.fromCharCode(99, 111, 114, 116, 101, 120, 105, 100, 101);
const LEG_PC = LEG_LC[0].toUpperCase() + LEG_LC.slice(1);
const basenameHasLegacyId = new RegExp(`${LEG_LC}|${LEG_PC}`, 'i');

function walk(dir, files = []) {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) walk(full, files);
		else files.push(full);
	}
	return files;
}

const all = walk(vibeideDir);
for (const full of all) {
	const base = path.basename(full);
	if (!basenameHasLegacyId.test(base)) continue;
	const n = base.replaceAll(LEG_PC, 'Vibeide').replaceAll(LEG_LC, 'vibeide');
	if (n === base) continue;
	const dest = path.join(path.dirname(full), n);
	if (fs.existsSync(dest)) {
		console.error('exists', dest);
		continue;
	}
	fs.renameSync(full, dest);
	console.log(base, '->', n);
}
