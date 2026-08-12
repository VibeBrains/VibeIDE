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
 * vscode-free: no imports beyond standard lib.
 */

export type ShellSafety = 'safe' | 'destructive' | 'ambiguous';

export interface ShellSafetyResult {
	safety: ShellSafety;
	reasons: string[];
	command: string;
	args: ReadonlyArray<string>;
}

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
 * Classify a parsed `(command, args)` pair. Pure.
 *
 * Decision priority (most-restrictive wins):
 *   1. Any destructive command pattern → destructive.
 *   2. Any destructive arg pattern → destructive.
 *   3. Special compound: `git push --force` / `git reset --hard` → destructive.
 *   4. Any ambiguous command without enough args → ambiguous.
 *   5. Otherwise → safe.
 */
export function analyzeNLShellSafety(
	command: string,
	args: ReadonlyArray<string>,
): ShellSafetyResult {
	const reasons: string[] = [];
	const cleanArgs = (args ?? []).map(a => typeof a === 'string' ? a.trim() : '').filter(a => a.length > 0);

	for (const p of DESTRUCTIVE_PATTERNS) {
		if (p.re.test(command)) {
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
	if (/^git$/i.test(command)) {
		const joined = cleanArgs.join(' ');
		if (/(^|\s)push\b.*--force\b/i.test(joined)) {
			reasons.push('git-push-force');
		}
		if (/(^|\s)reset\b.*--hard\b/i.test(joined)) {
			reasons.push('git-reset-hard');
		}
		if (/(^|\s)clean\b.*-(f|fd|fdx)\b/i.test(joined)) {
			reasons.push('git-clean-force');
		}
	}

	if (reasons.length > 0) {
		return { safety: 'destructive', reasons, command, args: cleanArgs };
	}

	// Ambiguous: command alone without args
	if (cleanArgs.length === 0) {
		for (const p of AMBIGUOUS_PATTERNS) {
			if (p.re.test(command)) {
				return { safety: 'ambiguous', reasons: [p.reason], command, args: cleanArgs };
			}
		}
	}

	return { safety: 'safe', reasons: [], command, args: cleanArgs };
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
 * Splits a raw shell line into the simple commands it will actually run.
 *
 * The classifier above judges a parsed `(command, args)` pair, but the terminal tool receives a
 * line — and the dangerous half of `npm test && rm -rf build` is the half after the `&&`. Judging
 * only the first word would wave that through.
 *
 * Deliberately shallow: separators (`&&`, `||`, `;`, `|`, newline) and quotes, nothing else. It is
 * a triage step before a confirmation dialog, not a shell. Substitutions, redirects and here-docs
 * are left inside the arguments where the argument patterns can still see them, and anything this
 * misparses shows up as a stranger-looking command in the dialog the user reads — never as silent
 * permission.
 */
export function splitShellSegments(line: string): Array<{ command: string; args: string[] }> {
	const segments: Array<{ command: string; args: string[] }> = [];
	let tokens: string[] = [];
	let current = '';
	let quote: '"' | '\'' | undefined;

	const endToken = () => { if (current) { tokens.push(current); current = ''; } };
	const endSegment = () => {
		endToken();
		if (tokens.length > 0) { segments.push({ command: tokens[0], args: tokens.slice(1) }); }
		tokens = [];
	};

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === quote) { quote = undefined; } else { current += ch; }
			continue;
		}
		if (ch === '"' || ch === '\'') { quote = ch; continue; }
		if (ch === '\\' && i + 1 < line.length) { current += line[++i]; continue; }
		if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
			// `&&` and `||` are two characters; a single `|` or `&` separates just as well for us.
			if ((ch === '|' || ch === '&') && line[i + 1] === ch) { i++; }
			endSegment();
			continue;
		}
		if (ch === ' ' || ch === '\t') { endToken(); continue; }
		current += ch;
	}
	endSegment();
	return segments;
}

/**
 * Worst verdict over every simple command in a raw shell line, or undefined when nothing is
 * destructive. Returning the offending segment (not just a flag) is the point: the dialog must
 * name the command the user is being asked about.
 */
export function analyzeShellLine(line: string): ShellSafetyResult | undefined {
	for (const segment of splitShellSegments(line)) {
		const verdict = analyzeNLShellSafety(segment.command, segment.args);
		if (verdict.safety === 'destructive') {
			return verdict;
		}
	}
	return undefined;
}
