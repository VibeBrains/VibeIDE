#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Сырой NUL-байт (0x00) в текстовом исходнике запрещён.
 *
 * Такой байт делает файл «двоичным» для поиска. `grep` в среде агента — обёртка над ugrep с `-I`,
 * и файл с NUL пропускается МОЛЧА: ни совпадения, ни ошибки, код выхода «не найдено». 11.09.2026 так
 * спрятался `convertToLLMMessageService.ts`: поиск вызовов списка скиллов вернул пусто, и чуть не был
 * сделан ложный вывод «список скиллов к модели не подключён». Там же нашёлся байт в `spendLedger.ts`,
 * третий агент вписал в новый файл сам, а первый полный прогон этого гейта нашёл четвёртый — в
 * `docs/knowledge/ui/vibeDocsPane.md`, в той самой строке, что предупреждает не писать живой байт; он
 * лежал там с 15.07.2026. Запись в базе знаний этого не остановила — поэтому гейт.
 *
 * WHY the byte appears at all: an agent types the escape for code point zero into an edit tool, and
 * the tool's JSON input decodes it into a real byte before the file is written. In a string the value
 * is the same either way; only the escape keeps the file text for every tool. That is also why the
 * escape and the separator below are assembled from character codes instead of being typed.
 *
 * WHY bytes and not grep: grep is exactly the tool that skips such files.
 *
 * WHY `--staged` reads the INDEX: what matters is what goes into the commit. lint-staged hides the
 * unstaged part of partially staged files before it runs tasks, so the paths it passes are read from
 * the working tree, which at that moment holds the staged content.
 *
 * Usage:
 *   node scripts/vibe-no-raw-nul.ts <files…>   the given files — lint-staged passes the staged paths
 *   node scripts/vibe-no-raw-nul.ts --staged   staged text sources, read from the index
 *   node scripts/vibe-no-raw-nul.ts --all      every tracked text source (npm run raw-nul-check)
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const cp: typeof import('child_process') = require('child_process');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');

/** Text sources this gate owns in `--staged` and `--all`: these folders, these extensions. */
const SCOPE_DIRS: readonly string[] = ['src', 'scripts', 'docs', 'build'];
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.md', '.json', '.mjs', '.cjs', '.js']);

/** Separator of `git … -z` output. */
const NUL = String.fromCharCode(0);

/** What to write instead of the byte: a backslash and `u0000`, six characters. */
const ESCAPE = `${String.fromCharCode(92)}u0000`;

/** Enough for `git ls-files` over the whole tree and for any single source file. */
const MAX_BUFFER = 256 * 1024 * 1024;

interface Source {
	/** Path shown to the author, relative to the repository root. */
	readonly file: string;
	/** The bytes to check, or undefined when there is nothing of the file to commit. */
	readonly read: () => Buffer | undefined;
}

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly column: number;
}

function inScope(file: string): boolean {
	const normalized = file.replace(/\\/g, '/');
	return SCOPE_DIRS.some(dir => normalized.startsWith(`${dir}/`)) && TEXT_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

/** File list printed by a git command with `-z`. Exits with code 2 when git fails: no list, no verdict. */
function gitList(args: readonly string[]): string[] {
	const result = cp.spawnSync('git', [...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER });
	if (result.status !== 0) {
		console.error(`❌ Не выполнилась команда git ${args.join(' ')}: ${(result.stderr ?? '').trim()}`);
		process.exit(2);
	}
	return result.stdout.split(NUL).filter(Boolean);
}

function fromWorkingTree(file: string): Source {
	const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
	return {
		file: path.relative(ROOT, abs).split(path.sep).join('/'),
		read: () => {
			try {
				// A symlink is committed as its target path, not as the file it points at.
				return fs.lstatSync(abs).isFile() ? fs.readFileSync(abs) : undefined;
			} catch {
				// Deleted or unreadable: nothing of it will be committed.
				return undefined;
			}
		},
	};
}

function fromIndex(file: string): Source {
	return {
		file,
		read: () => {
			// Environment kept on purpose: inside a hook GIT_INDEX_FILE names the index being committed.
			const result = cp.spawnSync('git', ['show', `:${file}`], { cwd: ROOT, maxBuffer: MAX_BUFFER });
			return result.status === 0 ? result.stdout : undefined;
		},
	};
}

function lineOf(bytes: Buffer, offset: number): number {
	let line = 1;
	for (let at = bytes.indexOf(0x0a); at !== -1 && at < offset; at = bytes.indexOf(0x0a, at + 1)) {
		line++;
	}
	return line;
}

function findRawNul(file: string, bytes: Buffer): Finding[] {
	const findings: Finding[] = [];
	for (let at = bytes.indexOf(0); at !== -1; at = bytes.indexOf(0, at + 1)) {
		const lineStart = bytes.lastIndexOf(0x0a, at) + 1;
		// The column editors show counts UTF-16 units, so the line prefix is decoded, not measured in bytes.
		const column = bytes.subarray(lineStart, at).toString('utf8').length + 1;
		findings.push({ file, line: lineOf(bytes, at), column });
	}
	return findings;
}

function sourcesFromArgs(args: readonly string[]): Source[] {
	if (args.includes('--all')) {
		return gitList(['ls-files', '-z', '--', ...SCOPE_DIRS]).filter(inScope).map(fromWorkingTree);
	}
	if (args.includes('--staged')) {
		return gitList(['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z']).filter(inScope).map(fromIndex);
	}
	const files = args.filter(arg => !arg.startsWith('--'));
	if (files.length === 0) {
		console.error('Использование: node scripts/vibe-no-raw-nul.ts <файлы…> | --staged | --all');
		process.exit(2);
	}
	return files.map(fromWorkingTree);
}

const findings: Finding[] = [];
let checked = 0;
for (const source of sourcesFromArgs(process.argv.slice(2))) {
	const bytes = source.read();
	if (!bytes) {
		continue;
	}
	checked++;
	if (bytes.includes(0)) {
		findings.push(...findRawNul(source.file, bytes));
	}
}

if (findings.length > 0) {
	console.error('❌ Сырой NUL-байт (0x00) в текстовом файле: поиск считает такой файл двоичным и молча его пропускает.');
	for (const { file, line, column } of findings) {
		console.error(`   ${file}:${line}:${column}`);
	}
	console.error(`\n   Вместо живого байта запишите escape-последовательность ${ESCAPE} — значение строки то же, файл останется текстом.`);
	console.error('   Инструмент правки агента сам превращает набранную escape-последовательность в байт: вставляйте её скриптом,');
	console.error('   собирая обратную косую черту из кода символа 92.');
	process.exit(1);
}
console.log(`✅ Сырых NUL-байтов нет (файлов проверено: ${checked}).`);
