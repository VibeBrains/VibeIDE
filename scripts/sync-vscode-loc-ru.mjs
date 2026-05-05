#!/usr/bin/env node
/**
 * Refresh core Russian translations from upstream vscode-loc (MIT).
 * Source: https://github.com/microsoft/vscode-loc
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outFile = path.join(root, 'extensions/vscode-language-pack-ru/translations/main.i18n.json');
const url =
	'https://raw.githubusercontent.com/microsoft/vscode-loc/main/i18n/vscode-language-pack-ru/translations/main.i18n.json';

const res = await fetch(url);
if (!res.ok) {
	console.error(`Fetch failed: ${res.status} ${res.statusText}`);
	process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, buf);
console.log(`Wrote ${outFile} (${buf.length} bytes)`);
