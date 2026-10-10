#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Every scroll container of VibeIDE's own surfaces carries the shared scrollbar
 *
 * A line that makes an element scrollable must mention `vibe-scroll`:
 * The class itself (`vibe-scroll`, `@@vibe-scroll` in the React tree), or a note saying where the class is set
 * (`overflow-y: auto; (comment) vibe-scroll: class set where the element is built`)
 *
 * WHY a gate: a container with `overflow: auto` and no scrollbar rule gets the system bar — a wide light strip
 * across a dark theme. It looks fine to the author on macOS with a trackpad, where system bars hide themselves,
 * and wrong to everyone with a mouse. The shared class existed for months and new panels still shipped without it
 *
 * WHY per line and not per element: a line is what a diff shows and what a reviewer reads.
 * Resolving which class ends up on which element would need the whole React tree
 *
 * Usage:
 *   node scripts/vibe-scroll-gate.ts <files…>   the given files — lint-staged passes the staged paths
 *   node scripts/vibe-scroll-gate.ts --all      every source of contrib/vibeide (npm run scroll-check)
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const cp: typeof import('child_process') = require('child_process');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');
const SCOPE = 'src/vs/workbench/contrib/vibeide/';
const EXTENSIONS: ReadonlySet<string> = new Set(['.css', '.ts', '.tsx']);
/** The shared scrollbar itself, build output, and tests that only quote the patterns */
const EXCLUDED: readonly RegExp[] = [/\/media\/vibeScroll\.css$/, /\/react\/out\//, /\/node_modules\//, /\/test\//];
const MARK = 'vibe-scroll';

/** What makes an element scrollable: a CSS declaration, a style object or assignment, a Tailwind class */
const SCROLLING: readonly RegExp[] = [
	/overflow(?:-[xy])?\s*:\s*(?:auto|scroll)\b/,
	/overflow[XY]?\s*(?::|=(?!=))[^,;]*['"`](?:auto|scroll)['"`]/,
	/\boverflow(?:-[xy])?-(?:auto|scroll)\b/,
];

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

function isOwned(file: string): boolean {
	const rel = file.split(path.sep).join('/');
	return rel.startsWith(SCOPE) && EXTENSIONS.has(path.extname(rel)) && !EXCLUDED.some(rule => rule.test(rel));
}

/** A line that is only a comment describes scrolling, it does not cause it */
function isCommentOnly(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function check(file: string): Finding[] {
	const findings: Finding[] = [];
	const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
	lines.forEach((text, index) => {
		if (!isCommentOnly(text) && !text.includes(MARK) && SCROLLING.some(rule => rule.test(text))) {
			findings.push({ file, line: index + 1, text: text.trim().slice(0, 140) });
		}
	});
	return findings;
}

const args = process.argv.slice(2);
const files = args.includes('--all')
	? cp.execFileSync('git', ['ls-files', SCOPE], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
	: args.map(file => path.relative(ROOT, path.resolve(file)));
const findings = files.filter(isOwned).filter(file => fs.existsSync(path.join(ROOT, file))).flatMap(check);

if (findings.length > 0) {
	console.error(`❌ Прокрутка без общей полосы: ${findings.length}`);
	for (const finding of findings) {
		console.error(`  ${finding.file}:${finding.line}  ${finding.text}`);
	}
	console.error('Контейнеру с прокруткой нужен класс vibe-scroll (в React — @@vibe-scroll) на той же строке.');
	console.error('Класс стоит в другом месте — допишите на строке пометку: vibe-scroll: где он задан.');
	console.error('Правило и причина — docs/knowledge/ui/scrollbar.md');
	process.exit(1);
}
console.log(`✅ Прокрутка: у всех контейнеров общая полоса (файлов проверено: ${files.filter(isOwned).length}).`);
