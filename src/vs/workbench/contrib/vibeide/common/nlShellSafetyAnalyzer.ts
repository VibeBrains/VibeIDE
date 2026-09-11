/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * NL shell safety analyzer (1056) — pure helper.
 *
 * `nlShellParserService` translates a natural-language input into a
 * `{ command, args }` pair. Before that runs, we want a safety pass that
 * classifies the parsed command:
 *
 *   safe         → run with confirm dialog only (e.g. `ls`, `git status`)
 *   destructive  → run with mandatory two-step confirm (e.g. `rm -rf`,
 *                  `chmod 777`, `truncate`, `dd`, `git push --force`).
 *   ambiguous    → cannot decide; surface the parsed command + ask user
 *                  before any execution.
 *
 * The DI service routes the answer to the confirm-dialog / Quick Pick
 * runtime; this module only does the classification.
 *
 * The line-level half (`analyzeShellLine`) behaves like VibeIDEA's port (`ShellSafetyAnalyzer.kt`):
 * the same grouping of a line, the same rule for code fetched from the network, the same reason
 * code. The two are kept alike by a shared test vector, not by shared code.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type ShellSafety = 'safe' | 'destructive' | 'ambiguous';

export interface ShellSafetyResult {
	safety: ShellSafety;
	reasons: string[];
	command: string;
	args: ReadonlyArray<string>;
}

/**
 * Reason for code fetched from the network and handed to an interpreter — the code VibeIDEA's port
 * reports too (`ShellSafetyAnalyzer.FETCH_AND_RUN`), so both products name the finding alike.
 */
export const FETCH_AND_RUN_REASON = 'fetch-piped-to-interpreter';

/** Patterns that always make the command destructive, regardless of context. */
const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
	// `rm -rf` / `rm -fr` / `rm -r --force` / wildcards on `rm`
	{ re: /^rm$/i, reason: 'rm-binary' },
	{ re: /^dd$/i, reason: 'dd-binary' },
	{ re: /^mkfs(\.|$)/i, reason: 'mkfs-binary' },
	{ re: /^shred$/i, reason: 'shred-binary' },
	{ re: /^truncate$/i, reason: 'truncate-binary' },
	// PowerShell equivalents
	{ re: /^Remove-Item$/i, reason: 'powershell-remove-item' },
	{ re: /^Format-Volume$/i, reason: 'powershell-format-volume' },
	{ re: /^(?:Clear-Disk|Remove-Partition)$/i, reason: 'powershell-disk' },
];

const DESTRUCTIVE_ARG_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
	{ re: /^--?force\b/i, reason: 'force-flag' },
	{ re: /-rf\b/i, reason: 'rf-flag' },
	{ re: /-fr\b/i, reason: 'fr-flag' },
	{ re: /^[\\/]$/, reason: 'root-path' },
	{ re: /^~$/, reason: 'home-path' },
	{ re: /^\*$/, reason: 'wildcard-only' },
	// `chmod 777`, `chmod -R 777`, etc.
	{ re: /^777$/, reason: 'chmod-777' },
	{ re: /^666$/, reason: 'chmod-666' },
];

const AMBIGUOUS_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
	{ re: /^git$/i, reason: 'git-command-needs-context' },
	{ re: /^npm$/i, reason: 'npm-command-needs-context' },
	{ re: /^docker$/i, reason: 'docker-command-needs-context' },
];

/**
 * Commands that run the command after them, each with its options that take a value.
 *
 * `sudo rm notes.txt` removes the file just the same, and judging the wrapper instead of what it
 * wraps waved that through. The value options matter for the same reason: in `sudo -u deploy rm`,
 * `deploy` is not the command.
 */
const COMMAND_WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
	['sudo', new Set(['-u', '-g', '-h', '-p', '-U', '-C', '-D', '-r', '-t', '-T'])],
	['doas', new Set(['-u', '-C'])],
	['env', new Set(['-u', '-C', '-S'])],
	['nice', new Set(['-n'])],
	['timeout', new Set(['-s', '-k'])],
	['stdbuf', new Set(['-i', '-o', '-e'])],
	['xargs', new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'])],
	['nohup', new Set()],
	['time', new Set()],
	['command', new Set()],
	['exec', new Set()],
]);

/** How many wrappers deep a command is looked for: `sudo env FOO=1 nice rm` is three. */
const MAX_WRAPPER_DEPTH = 4;

/** `NAME=value` before a command sets its environment; it is not the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Lower-case program name without directory or `.exe`/`.com`: `/usr/bin/Bash.exe` → `bash`. */
function programOf(command: string): string {
	const base = command.replace(/\\/g, '/').split('/').pop() ?? command;
	return base.replace(/\.(?:exe|com)$/i, '').toLowerCase();
}

/** Peel assignments and wrappers — with their options and `timeout`'s duration — off a command. */
function unwrapCommand(command: string, args: ReadonlyArray<string>): { command: string; args: string[] } {
	let tokens = [command, ...args];
	for (let depth = 0; depth < MAX_WRAPPER_DEPTH && tokens.length > 1; depth++) {
		while (tokens.length > 1 && ASSIGNMENT.test(tokens[0])) {
			tokens = tokens.slice(1);
		}
		const wrapper = programOf(tokens[0]);
		const optionsWithValue = COMMAND_WRAPPERS.get(wrapper);
		// `command -v rm` looks the name up instead of running it.
		if (!optionsWithValue || tokens.length < 2 || (wrapper === 'command' && /^-[vV]$/.test(tokens[1]))) {
			break;
		}
		tokens = tokens.slice(1);
		while (tokens.length > 1) {
			const token = tokens[0];
			if (optionsWithValue.has(token) && tokens.length > 2) {
				tokens = tokens.slice(2);
			} else if (token.startsWith('-') || ASSIGNMENT.test(token)) {
				tokens = tokens.slice(1);
			} else {
				break;
			}
		}
		if (wrapper === 'timeout' && tokens.length > 1 && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[0])) {
			tokens = tokens.slice(1);
		}
	}
	return { command: tokens[0], args: tokens.slice(1) };
}

function unwrapStage(stage: readonly string[]): { command: string; args: string[] } {
	return unwrapCommand(stage[0], stage.slice(1));
}

/** Disk tools: one wrong device name is a lost disk. */
const DISK_TOOLS = /^(?:fdisk|sfdisk|gdisk|sgdisk|parted|wipefs|diskpart)$/;
/** Arguments that only look: list, print, help, script mode, the device looked at. */
const DISK_LOOKING_ARG = /^(?:-l|--list|-p|--print|print|-s|--script|-h|--help|-V|--version|\/dev\/\S+)$/;
const DISK_LISTING_ARG = /^(?:-l|--list|-p|--print|print)$/;

/**
 * Whether a disk tool is asked to change a disk rather than to show one. `fdisk -l` is how people
 * look at partitions, and a dialog on it would teach them to click through the one on `fdisk /dev/sda`.
 */
function writesDisk(program: string, args: readonly string[]): boolean {
	if (program === 'diskutil') {
		const [verb = '', object = ''] = args;
		return /^(?:erase\w*|zerodisk|randomdisk|secureerase|partitiondisk|reformat)$/i.test(verb)
			|| (/^apfs$/i.test(verb) && /^(?:delete\w*|erase\w*)$/i.test(object));
	}
	if (!DISK_TOOLS.test(program)) {
		return false;
	}
	const onlyLooks = args.every(arg => DISK_LOOKING_ARG.test(arg));
	// `wipefs` lists signatures unless told to erase them; the others have to be asked to list.
	return !onlyLooks || (program !== 'wipefs' && !args.some(arg => DISK_LISTING_ARG.test(arg)));
}

/**
 * Classify a parsed `(command, args)` pair. Pure.
 *
 * Decision priority (most-restrictive wins):
 *   1. Any destructive command pattern → destructive.
 *   2. Any destructive arg pattern → destructive.
 *   3. Special compounds: `git push --force|-f`, `git reset --hard`, `format D:`, disk tools that write → destructive.
 *   4. Any ambiguous command without enough args → ambiguous.
 *   5. Otherwise → safe.
 *
 * Assignments and wrappers (`sudo`, `env`, `timeout`, `xargs` …) are peeled off first, so the command
 * judged is the one that actually runs.
 */
export function analyzeNLShellSafety(
	command: string,
	args: ReadonlyArray<string>,
): ShellSafetyResult {
	const reasons: string[] = [];
	const cleaned = (args ?? []).map(a => typeof a === 'string' ? a.trim() : '').filter(a => a.length > 0);
	const target = unwrapCommand(command, cleaned);
	const cleanArgs = target.args;
	const program = programOf(target.command);

	for (const p of DESTRUCTIVE_PATTERNS) {
		if (p.re.test(program)) {
			reasons.push(p.reason);
		}
	}
	for (const arg of cleanArgs) {
		for (const p of DESTRUCTIVE_ARG_PATTERNS) {
			if (p.re.test(arg)) {
				reasons.push(p.reason);
			}
		}
	}

	// Special compounds: git push --force / git reset --hard
	if (program === 'git') {
		const joined = cleanArgs.join(' ');
		// `-f` is as much a force push as `--force` — and so is a short-option cluster with `f` (`-uf`).
		if (/(^|\s)push\b.*(--force\b|\s-[a-zA-Z]*f[a-zA-Z]*\b)/i.test(joined)) {
			reasons.push('git-push-force');
		}
		if (/(^|\s)reset\b.*--hard\b/i.test(joined)) {
			reasons.push('git-reset-hard');
		}
		if (/(^|\s)clean\b.*-(f|fd|fdx)\b/i.test(joined)) {
			reasons.push('git-clean-force');
		}
	}
	// Windows `format D:` — the name alone is too common to judge (`npm run format`), the drive is not.
	if (program === 'format' && cleanArgs.some(a => /^[A-Za-z]:$/.test(a))) {
		reasons.push('format-drive');
	}
	if (writesDisk(program, cleanArgs)) {
		reasons.push('disk-tool');
	}

	if (reasons.length > 0) {
		return { safety: 'destructive', reasons, command: target.command, args: cleanArgs };
	}

	// Ambiguous: command alone without args
	if (cleanArgs.length === 0) {
		for (const p of AMBIGUOUS_PATTERNS) {
			if (p.re.test(program)) {
				return { safety: 'ambiguous', reasons: [p.reason], command: target.command, args: cleanArgs };
			}
		}
	}

	return { safety: 'safe', reasons: [], command: target.command, args: cleanArgs };
}

/**
 * Build the confirmation dialog body for a destructive command. Pure —
 * caller renders this in the modal.
 */
export function describeShellSafetyResult(result: ShellSafetyResult): string {
	const argsText = result.args.length > 0 ? ' ' + result.args.join(' ') : '';
	const head = `${result.command}${argsText}`;
	if (result.safety === 'safe') {
		return `Will run: \`${head}\``;
	}
	if (result.safety === 'ambiguous') {
		return `Ambiguous: \`${head}\` — provide arguments before running.`;
	}
	return `DESTRUCTIVE: \`${head}\`\nReasons: ${result.reasons.join(', ')}\n\nThis will likely cause data loss. Confirm twice if you really intend it.`;
}

/**
 * A raw shell line as the shell groups it: chains (split at `;`, `&&`, `||`, `&`, newline), each a
 * list of pipeline stages (split at `|` and `|&`), each a list of words.
 *
 * The classifier above judges a parsed `(command, args)` pair, but the terminal tool receives a
 * line — and the dangerous half of `npm test && rm -rf build` is the half after the `&&`. The pipe
 * is kept apart from the other separators because `curl … | sh` is two harmless halves judged one
 * at a time, and dangerous only as a pair.
 *
 * Deliberately shallow: separators, quotes, backslashes, and `$( … )` / `<( … )` / backticks kept
 * whole as one word, nothing else. `2>&1` and `&>file` are redirections, not separators. `#` is NOT
 * a comment here: cmd.exe has none, and `echo # & format D:` runs the format there. Anything this
 * misparses shows up as a stranger-looking command in the dialog the user reads — never as silent
 * permission.
 */
export function parseShellLine(line: string): string[][][] {
	const chains: string[][][] = [];
	let stages: string[][] = [];
	let words: string[] = [];
	let word = '';
	let quote: string | undefined;
	let backtick = false;
	let nesting = 0;

	const endWord = () => { if (word) { words.push(word); word = ''; } };
	const endStage = () => { endWord(); if (words.length > 0) { stages.push(words); } words = []; };
	const endChain = () => { endStage(); if (stages.length > 0) { chains.push(stages); } stages = []; };

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		const next = line[i + 1];
		if (nesting > 0) {
			// Inside `$( … )` the text is kept verbatim — it is a line of its own, judged later.
			// Quotes only stop the parentheses inside them from counting.
			word += ch;
			if (ch === '\\' && next !== undefined) {
				word += next;
				i++;
			} else if (quote) {
				if (ch === quote) { quote = undefined; }
			} else if (ch === '"' || ch === '\'') {
				quote = ch;
			} else if (ch === '(') {
				nesting++;
			} else if (ch === ')') {
				nesting--;
			}
		} else if (quote) {
			if (ch === quote) { quote = undefined; } else { word += ch; }
		} else if (ch === '`') {
			backtick = !backtick;
			word += ch;
		} else if (backtick) {
			word += ch;
		} else if (ch === '"' || ch === '\'') {
			quote = ch;
		} else if (ch === '\\' && next !== undefined) {
			word += next;
			i++;
		} else if ((ch === '$' || ch === '<' || ch === '>') && next === '(') {
			nesting = 1;
			word += ch + next;
			i++;
		} else if (ch === '|' && next === '|') {
			endChain();
			i++;
		} else if (ch === '|') {
			// `|&` pipes stderr along with stdout: still one pipeline.
			endStage();
			if (next === '&') { i++; }
		} else if (ch === '&' && next === '&') {
			endChain();
			i++;
		} else if (ch === '&' && (next === '>' || word.endsWith('>') || word.endsWith('<'))) {
			// `2>&1`, `&>file`: a redirection, not a separator.
			word += ch;
		} else if (ch === ';' || ch === '\n' || ch === '\r' || ch === '&') {
			endChain();
		} else if (ch === ' ' || ch === '\t') {
			endWord();
		} else {
			word += ch;
		}
	}
	endChain();
	return chains;
}

/** The simple commands of a raw line, in order, without their grouping — see `parseShellLine`. */
export function splitShellSegments(line: string): Array<{ command: string; args: string[] }> {
	return parseShellLine(line).flat().map(words => ({ command: words[0], args: words.slice(1) }));
}

/** Nested scripts and substitutions are judged too, down to this depth. */
const MAX_NESTED_DEPTH = 3;

const SHELL = /^(?:ba|z|da|k|mk|fi|a|c|tc)?sh$/;
const POWERSHELL = /^(?:pwsh|powershell)$/;

/**
 * How an interpreter is told where its program is: `programFlags` take it from their argument
 * (`-c`, `-e`), `stdinFlags` read it from standard input (`sh -s`); the letters are the same flags
 * inside a cluster of short options.
 */
interface Interpreter {
	readonly names: RegExp;
	readonly programFlags: ReadonlySet<string>;
	readonly programLetters: string;
	readonly stdinFlags?: ReadonlySet<string>;
	readonly stdinLetters?: string;
	readonly ignoreCase?: boolean;
}

const INTERPRETERS: readonly Interpreter[] = [
	{ names: SHELL, programFlags: new Set(['-c']), programLetters: 'c', stdinFlags: new Set(['-s']), stdinLetters: 's' },
	{ names: /^(?:python[0-9.]*|pypy[0-9.]*)$/, programFlags: new Set(['-c', '-m']), programLetters: 'cm' },
	{ names: /^(?:node|nodejs|deno|bun)$/, programFlags: new Set(['-e', '-p', '--eval', '--print']), programLetters: 'ep' },
	{ names: /^(?:ruby|perl|lua|osascript)$/, programFlags: new Set(['-e']), programLetters: 'e' },
	{ names: /^php$/, programFlags: new Set(['-r']), programLetters: 'r' },
	{ names: POWERSHELL, programFlags: new Set(['-command', '-c', '-encodedcommand', '-ec', '-file', '-f']), programLetters: '', ignoreCase: true },
];

/** Programs that fetch from the network and print what they fetched. */
const FETCHERS: ReadonlySet<string> = new Set(['curl', 'wget', 'fetch', 'aria2c', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);

/** Run their arguments as shell code. */
const EVALUATORS: ReadonlySet<string> = new Set(['eval', 'source', '.']);

/** Run their input as code, whatever the flags — and their argument, which is PowerShell too. */
const INPUT_EVALUATORS: ReadonlySet<string> = new Set(['iex', 'invoke-expression']);

/** A download inside a PowerShell expression: `iex (iwr …)`, `iex (New-Object Net.WebClient).DownloadString(…)`. */
const POWERSHELL_DOWNLOAD = /(?:^|[\s(])(?:iwr|irm|curl|wget|invoke-webrequest|invoke-restmethod)\b|\.download(?:string|data|file)\s*\(/i;

/**
 * Worst verdict over every simple command in a raw shell line, or undefined when nothing is
 * destructive. Returning the offending command (not just a flag) is the point: the dialog must
 * name the command the user is being asked about.
 */
export function analyzeShellLine(line: string): ShellSafetyResult | undefined {
	return analyzeLine(line, 0);
}

function analyzeLine(line: string, depth: number): ShellSafetyResult | undefined {
	const chains = parseShellLine(line);
	for (const stage of chains.flat()) {
		const verdict = analyzeNLShellSafety(stage[0], stage.slice(1));
		if (verdict.safety === 'destructive') {
			return verdict;
		}
		// `bash -c "rm notes.txt"`, `eval "rm notes.txt"`: the script handed over is a line of its own.
		const script = depth < MAX_NESTED_DEPTH ? scriptOf(verdict.command, verdict.args) : undefined;
		const nested = script !== undefined ? analyzeLine(script, depth + 1) : undefined;
		if (nested) {
			return nested;
		}
	}
	if (depth < MAX_NESTED_DEPTH) {
		// `echo $(rm notes.txt)`: a substitution runs before the command that reads its output.
		for (const inner of extractSubstitutions(line)) {
			const nested = analyzeLine(inner, depth + 1);
			if (nested) {
				return nested;
			}
		}
	}
	const offending = findFetchAndRun(chains, depth);
	if (!offending) {
		return undefined;
	}
	const { command, args } = unwrapStage(offending);
	return { safety: 'destructive', reasons: [FETCH_AND_RUN_REASON], command, args };
}

/** Whether a raw line hands code fetched from the network to an interpreter — see `findFetchAndRun`. */
export function fetchesAndRuns(line: string): boolean {
	return findFetchAndRun(parseShellLine(line), 0) !== undefined;
}

/**
 * A command that fetches code and runs it, inside one line of free text — prose or a script.
 *
 * Prose puts words before the command («Сначала выполни: curl … | sh»), and a line-level parse takes
 * «Сначала» for the command. So every word that can begin such a command — a download, an
 * interpreter, an evaluator, a wrapper — is tried as the start of the line. Returns the command from
 * that word on, or undefined. Markdown inline code is the caller's to unwrap: a backtick here is
 * shell syntax.
 */
export function findFetchAndRunInText(line: string): string | undefined {
	const words = /\S+/g;
	for (let match = words.exec(line); match; match = words.exec(line)) {
		// Punctuation that opens prose or a subshell: «(curl», «"eval».
		const lead = /^[("'«]*/.exec(match[0])?.[0].length ?? 0;
		if (!startsCommand(programOf(match[0].slice(lead).replace(/[.,:;!?»"')]+$/, '')))) {
			continue;
		}
		// Sentence punctuation after the command is not part of it: «… | sh.» ends with `sh`.
		const candidate = line.slice(match.index + lead).replace(/[\s.,:!?»]+$/, '');
		if (fetchesAndRuns(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/** Words that can begin a fetch-and-run command. */
function startsCommand(program: string): boolean {
	return FETCHERS.has(program) || EVALUATORS.has(program) || INPUT_EVALUATORS.has(program)
		|| COMMAND_WRAPPERS.has(program) || INTERPRETERS.some(interpreter => interpreter.names.test(program));
}

/** The line a command runs as code: the script of `sh -c "<script>"` / `pwsh -Command`, the words of `eval`. */
function scriptOf(command: string, args: readonly string[]): string | undefined {
	const program = programOf(command);
	if (program === 'eval') {
		return args.length > 0 ? args.join(' ') : undefined;
	}
	if (!SHELL.test(program) && !POWERSHELL.test(program)) {
		return undefined;
	}
	const at = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a) || /^-command$/i.test(a));
	return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
}

/**
 * Код из сети, отданный интерпретатору: `curl … | sh`, `iwr … | iex`, `bash <(curl …)`,
 * `eval "$(curl …)"`, `sh -c "curl … | sh"`. Returns the stage to name in the dialog: the download
 * for a pipe, the interpreter for the other forms.
 *
 * Neither half is destructive: a download changes nothing, and neither does a shell. Together they
 * run whatever the server returns at that second, read by nobody. The rule is on the composition, so
 * it holds with arguments after the interpreter (`| sh -s -- --yes`) and for any interpreter, not
 * only `sh` at the end of the line — the two gaps of the line-end pattern this replaced.
 *
 * An interpreter counts only when it takes its PROGRAM from the pipe: `| python3 -m json.tool`
 * pretty-prints an answer and is left alone. Not caught: a download saved to a file and run by the
 * next command (`curl -o i.sh … && sh i.sh`) — telling that from an ordinary build step needs
 * knowing what the file is.
 */
function findFetchAndRun(chains: readonly (readonly string[])[][], depth: number): readonly string[] | undefined {
	for (const chain of chains) {
		const fetchAt = chain.findIndex(stage => FETCHERS.has(programOf(unwrapStage(stage).command)));
		if (fetchAt >= 0 && chain.slice(fetchAt + 1).some(runsStdin)) {
			return chain[fetchAt];
		}
		if (depth >= MAX_NESTED_DEPTH) {
			continue;
		}
		for (const stage of chain) {
			const { command, args } = unwrapStage(stage);
			const program = programOf(command);
			if (INPUT_EVALUATORS.has(program) && POWERSHELL_DOWNLOAD.test(args.join(' '))) {
				return stage;
			}
			// What the stage runs as a program: every argument of eval / source / `.`, the program
			// operand of an interpreter.
			const programs = EVALUATORS.has(program) ? args : [programOperand(program, args)].filter((text): text is string => text !== undefined);
			for (const text of programs) {
				if (extractSubstitutions(text).some(inner => fetches(inner, depth + 1))) {
					return stage;
				}
				// `sh -c "curl … | sh"`: the operand is a line of its own.
				if ((EVALUATORS.has(program) || SHELL.test(program) || POWERSHELL.test(program)) && findFetchAndRun(parseShellLine(text), depth + 1)) {
					return stage;
				}
			}
		}
	}
	return undefined;
}

/**
 * Does this stage run what arrives on its standard input as a PROGRAM? `python3 -m json.tool` after
 * `curl` pretty-prints; `python3 -` runs. Without the difference the rule would fire on the most
 * ordinary way to read a JSON answer, and a warning that fires on the ordinary is a warning people
 * learn to click through.
 */
function runsStdin(stage: readonly string[]): boolean {
	const { command, args } = unwrapStage(stage);
	const program = programOf(command);
	if (INPUT_EVALUATORS.has(program)) {
		return true;
	}
	const interpreter = INTERPRETERS.find(candidate => candidate.names.test(program));
	if (!interpreter) {
		return false;
	}
	for (let i = 0; i < args.length; i++) {
		const arg = interpreter.ignoreCase ? args[i].toLowerCase() : args[i];
		if (arg === '-') {
			return true;
		}
		// What follows `--` is a script and its arguments; a bare `--` at the end reads stdin.
		if (arg === '--') {
			return i === args.length - 1;
		}
		// An operand is a script file: the pipe is its data, not its program.
		if (!arg.startsWith('-')) {
			return false;
		}
		if (interpreter.stdinFlags?.has(arg)) {
			return true;
		}
		if (interpreter.programFlags.has(arg)) {
			return args[i + 1] === '-';
		}
		// A cluster of short flags: `-xs`, `-ec`, `-lane`.
		if (!arg.startsWith('--') && arg.length > 2) {
			const letters = [...arg.slice(1)];
			if (letters.some(letter => interpreter.stdinLetters?.includes(letter))) {
				return true;
			}
			if (letters.some(letter => interpreter.programLetters.includes(letter))) {
				return false;
			}
		}
	}
	return true;
}

/** The operand an interpreter takes its program from — after `-c`/`-e` or not, it is the first one. */
function programOperand(program: string, args: readonly string[]): string | undefined {
	return INTERPRETERS.some(interpreter => interpreter.names.test(program)) ? args.find(arg => !arg.startsWith('-')) : undefined;
}

/** Whether a line downloads anything — directly or in a substitution of its own. */
function fetches(text: string, depth: number): boolean {
	return parseShellLine(text).some(chain => chain.some(stage => FETCHERS.has(programOf(unwrapStage(stage).command))))
		|| (depth < MAX_NESTED_DEPTH && extractSubstitutions(text).some(inner => fetches(inner, depth + 1)));
}

/** Inner lines of every `$( … )`, `<( … )`, `>( … )` and backtick span: they run before the command around them. */
function extractSubstitutions(text: string): string[] {
	const found: string[] = [];
	for (let i = 0; i + 1 < text.length; i++) {
		if ((text[i] === '$' || text[i] === '<' || text[i] === '>') && text[i + 1] === '(') {
			let open = 1;
			let j = i + 2;
			for (; j < text.length; j++) {
				if (text[j] === '(') {
					open++;
				} else if (text[j] === ')' && --open === 0) {
					break;
				}
			}
			found.push(text.slice(i + 2, j));
			i = j;
		}
	}
	const spans = text.split('`');
	for (let k = 1; k + 1 < spans.length; k += 2) {
		found.push(spans[k]);
	}
	return found.filter(inner => inner.trim().length > 0);
}
