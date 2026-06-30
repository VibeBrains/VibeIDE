/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Tool-hardening utilities — anti-shell contract, truncation, structured errors.
 *
 * Goal: prevent the LLM from collapsing into shell pipes (Get-Content / cat / findstr)
 * when a dedicated built-in tool exists. Long shell stdout is the primary cause of
 * IDE/host hangs we observed in other agent frontends.
 *
 * Rules are data-driven via `shellHardeningDefaults.ts` and workspace overrides in
 * `.vibe/shell-hardening.json` (loaded by `shellHardeningService.ts`). The legacy
 * `detectShellMisuse(cmd)` signature still works — it falls back to the bundled
 * default ruleset and an empty allow-list, which preserves behaviour for callers
 * that haven't been migrated to the service yet.
 */

import { DEFAULT_SHELL_HARDENING_RULES } from './shellHardeningDefaults.js';
import { ShellHardeningConfig, ShellHardeningRule, ShellMisuse } from './shellHardeningTypes.js';

export type { ShellMisuse, ShellMisuseKind } from './shellHardeningTypes.js';

/**
 * Compile a regex source into a cached RegExp. We cache because the same patterns
 * are matched against every shell command issued in a session — recompiling per
 * call would burn CPU on hot paths.
 */
const _regexCache = new Map<string, RegExp>();
function compile(source: string, flags = 'i'): RegExp {
	const key = `${flags}:${source}`;
	let re = _regexCache.get(key);
	if (!re) {
		re = new RegExp(source, flags);
		_regexCache.set(key, re);
	}
	return re;
}

/** Extract bare command name (no path, no .exe/.cmd/.bat/.ps1 suffix). */
function extractHead(rawCommand: string): { stripped: string; bareName: string } | null {
	const cmd = rawCommand.trim();
	if (!cmd) { return null; }
	const stripped = cmd
		.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/i, '') // POSIX env-var prefix
		.replace(/^&\s+/, '')                            // PowerShell call-operator
		.replace(/^['"]?/, '')                           // leading quote (e.g. `"path with spaces" arg`)
		.trim();
	const head = stripped.split(/[\s|&;]/, 1)[0]?.toLowerCase() ?? '';
	const bareName = head.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, '') ?? '';
	return { stripped, bareName };
}

/**
 * Apply a single rule to a command. Returns ShellMisuse if the rule fires, null otherwise.
 */
function applyRule(rule: ShellHardeningRule, stripped: string, bareName: string): ShellMisuse | null {
	if (!compile(rule.bareName).test(bareName)) { return null; }

	const tail = stripped.slice(bareName.length).trim();

	if (rule.requires?.notPiped && stripped.includes('|')) { return null; }
	if (rule.requires?.tailMatches && !compile(rule.requires.tailMatches).test(tail)) { return null; }

	if (rule.exempts) {
		for (const ex of rule.exempts) {
			if (compile(ex).test(tail)) { return null; }
		}
	}

	return {
		kind: rule.kind,
		suggestedTool: rule.suggestedTool,
		hint: rule.hint.replace(/\{bareName\}/g, bareName),
	};
}

/**
 * If the command is a shell wrapper that executes an inner command string
 * (`cmd /c "…"`, `powershell -Command "…"`, `bash -c "…"`, …), return that inner command so the
 * hardening rules can be re-evaluated against the REAL command. Otherwise `cmd /c "tree /F"` slips
 * past the head-of-command check (the head is `cmd`, not `tree`) — exactly how a recursive `tree`
 * froze the Extension Host for 67s. Returns null when this is not a recognised wrapper form.
 */
function unwrapShellWrapper(stripped: string, bareName: string): string | null {
	if (!/^(cmd|powershell|pwsh|bash|sh|zsh)$/.test(bareName)) { return null; }
	const afterExe = stripped.replace(/^\S+\s*/, ''); // drop the wrapper executable token
	const m = afterExe.match(/^(?:\/[ck]|-c|-command|--command)\b\s*(.*)$/is);
	if (!m) { return null; }
	let inner = m[1].trim();
	// Strip one layer of wrapping quotes around the inner command.
	if (inner.length >= 2 && ((inner[0] === '"' && inner[inner.length - 1] === '"') || (inner[0] === '\'' && inner[inner.length - 1] === '\''))) {
		inner = inner.slice(1, -1).trim();
	}
	return inner || null;
}

/**
 * Returns a misuse descriptor if the given shell command duplicates a built-in tool.
 * Returns null for legitimate shell usage (git, npm, build scripts, tests, etc).
 *
 * Conservative on purpose: only flags head-of-command invocations. Commands that
 * *contain* these as substrings inside a larger pipeline are not blocked.
 *
 * When `config` is provided, `config.allowedPatterns` short-circuits (any match
 * returns null = allowed), then default rules run minus `config.disableDefaultRules`,
 * then `config.extraRules` run last.
 */
export function detectShellMisuse(rawCommand: string, config?: ShellHardeningConfig, _depth = 0): ShellMisuse | null {
	const head = extractHead(rawCommand);
	if (!head) { return null; }
	const { stripped, bareName } = head;
	if (!bareName) { return null; }

	// Workspace allow-list short-circuit.
	if (config?.allowedPatterns) {
		for (const pattern of config.allowedPatterns) {
			try {
				if (compile(pattern).test(stripped)) { return null; }
			} catch {
				// Invalid user regex — skip silently. Service surfaces a corrupt-config
				// notification once at load time; per-call logging would spam.
			}
		}
	}

	const disabledIds = new Set(config?.disableDefaultRules ?? []);
	for (const rule of DEFAULT_SHELL_HARDENING_RULES) {
		if (disabledIds.has(rule.id)) { continue; }
		const misuse = applyRule(rule, stripped, bareName);
		if (misuse) { return misuse; }
	}

	if (config?.extraRules) {
		for (const rule of config.extraRules) {
			const misuse = applyRule(rule, stripped, bareName);
			if (misuse) { return misuse; }
		}
	}

	// D.39: re-check inside shell wrappers (`cmd /c "…"`, `bash -c "…"`, …) so head-of-command rules
	// aren't bypassed by quoting the real command. Bounded recursion guards pathological nesting.
	// Depth 2 covers a single legitimate wrapper-in-wrapper (`cmd /c "bash -c ..."`); deeper nesting
	// is adversarial obfuscation, not real usage, so we stop unwrapping rather than spin.
	if (_depth < 2) {
		const inner = unwrapShellWrapper(stripped, bareName);
		if (inner && inner !== rawCommand.trim()) {
			return detectShellMisuse(inner, config, _depth + 1);
		}
	}

	return null;
}

/**
 * Structured tool-validation error. Surfaces a stable error_code + hint
 * pair that the LLM can parse without scraping the message string.
 */
export class ToolValidationError extends Error {
	readonly code: string;
	readonly hint?: string;
	readonly suggestedTool?: string;

	constructor(opts: { code: string; message: string; hint?: string; suggestedTool?: string }) {
		super(opts.message);
		this.name = 'ToolValidationError';
		this.code = opts.code;
		this.hint = opts.hint;
		this.suggestedTool = opts.suggestedTool;
	}
}

/**
 * Truncate a string to at most `cap` characters by keeping the head and tail,
 * joining them with a separator that announces the elision. Stable shape for
 * model consumption: model can recognise the marker and request a re-read.
 */
export function truncateHeadTail(s: string, cap: number, marker = '\n...\n[truncated]\n...\n'): string {
	if (s.length <= cap) { return s; }
	const slack = Math.max(0, cap - marker.length);
	const half = Math.floor(slack / 2);
	return s.slice(0, half) + marker + s.slice(s.length - (slack - half));
}

/**
 * Detects whether terminal output ends in a shell line-continuation prompt,
 * i.e. the shell is blocked waiting for more input rather than executing.
 *
 * The signature is a final non-empty line consisting solely of `>` chevrons:
 * PowerShell emits `>>` when a quote / here-string (`@"`/`"@`) is left open,
 * POSIX shells emit `>` for an unclosed quote / heredoc. When a `run_command`
 * times out on inactivity AND the tail looks like this, re-running the identical
 * command just hangs again — the model should switch to rewrite_file/edit_file
 * instead of building a file line-by-line in the shell (model-stalls #015, where
 * this loop burned ~5M tokens across three sessions).
 *
 * Conservative on purpose: only the last non-empty line is inspected, and it must
 * be ONLY chevrons — a line that merely contains `>` (e.g. a redirect echoed in
 * output) does not match.
 */
export function looksLikeShellAwaitingInput(output: string): boolean {
	if (!output) { return false; }
	const lines = output.replace(/[\r\n]+$/, '').split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (trimmed === '') { continue; }
		// 1–3 chevrons covers the common interactive continuation prompts (`>`, `>>`, `>>>`:
		// shells, Python REPL, node REPL). More than three is not a known prompt form, so we
		// don't treat it as "awaiting input".
		return /^>{1,3}$/.test(trimmed);
	}
	return false;
}

/**
 * Build the agent-facing notice appended to a `run_command` result when it resolved by INACTIVITY
 * TIMEOUT (roadmap #1640). The temporary terminal is disposed on timeout (terminalToolService
 * `interrupt()`), which TERMINATES the command — so the captured output is PARTIAL and the command
 * did NOT complete. The agent previously read the bare "timed out" line as a finished step and moved
 * on (e.g. abandoning a still-deploying `git push`). This notice makes non-completion explicit.
 *
 * Pure / deterministic — the wording is locked by tests so it can't silently regress to an ambiguous
 * "timed out" that reads as success.
 */
export function formatTerminalTimeoutNotice(usedSeconds: number, awaitingInput: boolean): string {
	const lead = `⚠️ Command did NOT finish: VibeIDE terminated it after ${usedSeconds}s of inactivity (no new output). The output above is PARTIAL — do NOT assume it succeeded or completed.`;
	const tail = awaitingInput
		? ' The shell was waiting for more input (a ">>" continuation prompt) — most likely an unterminated quote or here-string. Do NOT re-run the same command; to write file contents use the rewrite_file or edit_file tool instead of building the file line-by-line in the shell.'
		: ' Re-run with a larger timeout_ms (max 600000), or set run_in_background=true to keep it running and poll output via read_background_output.';
	return `${lead}${tail}`;
}

/**
 * Shrink an inclusive 1-based line window [startLine, endLine] so the '\n'-joined content fits a
 * char budget. Used by read_file's large-file guard: a full default read of a huge file can pass
 * the line limit (long lines) yet dump hundreds of KB into the context in one tool result.
 *
 * Always keeps at least the first line — a single pathological line (minified bundle) may exceed
 * the budget on its own; the byte-level page cap downstream still bounds it. Returns the new
 * inclusive end line (≤ endLine, ≥ startLine).
 */
export function clampLineWindowToCharBudget(allLines: readonly string[], startLine: number, endLine: number, charBudget: number): number {
	let used = 0;
	let end = startLine;
	for (let ln = startLine; ln <= endLine && ln <= allLines.length; ln++) {
		const len = allLines[ln - 1].length + (ln > startLine ? 1 : 0); // +1 for the joining '\n'
		if (ln > startLine && used + len > charBudget) { break; }
		used += len;
		end = ln;
	}
	return end;
}

/**
 * Heuristic line-counter for cap-decisions without materialising arrays.
 */
export function countLines(s: string): number {
	if (!s) { return 0; }
	let n = 1;
	for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) === 10) { n++; } }
	return n;
}
