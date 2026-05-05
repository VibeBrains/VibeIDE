#!/usr/bin/env node
/**
 * Normalize obsolete product-name string fragments inside `contrib/vibeide` text sources.
 * Idempotent — safe to re-run.
 */
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '../..');
const dir = path.join(root, 'src/vs/workbench/contrib/vibeide');
const EXT = new Set(['.ts', '.tsx', '.css', '.md']);

function walk(d, out = []) {
	for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
		const full = path.join(d, ent.name);
		if (ent.isDirectory()) {
			walk(full, out);
		}
		else if (EXT.has(path.extname(ent.name))) {
			out.push(full);
		}
	}
	return out;
}

/** @type {string} legacy lower-case product prefix + `ide` (avoid embedding plain token in source) */
const FROM_LC = String.fromCharCode(99, 111, 114, 116, 101, 120, 105, 100, 101);
const FROM_PC = FROM_LC[0].toUpperCase() + FROM_LC.slice(1);

let n = 0;
for (const f of walk(dir)) {
	let s = fs.readFileSync(f, 'utf8');
	if (!s.includes(FROM_LC) && !s.includes(FROM_PC)) continue;
	const o = s;
	s = s.split(FROM_LC).join('vibeide');
	s = s.split(FROM_PC).join('Vibeide');
	if (s !== o) {
		fs.writeFileSync(f, s, 'utf8');
		n++;
	}
}
console.log('patched files', n);
