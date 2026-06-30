/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands sanitizer (335 / 336) — pure helpers.
 *
 * Validation runs at two points:
 *   - on import (community pack / tasks.json): zero-width / Bidi / injection
 *     check on the command + args before the entry lands in `.vibe/commands.json`.
 *   - at run time: cwd realpath check (must be within workspace root) +
 *     shell metacharacter check on args unless the entry has `shell: true`.
 *
 * vscode-free: no imports beyond standard lib and the Project Commands
 * types (which are already vscode-free).
 */

import type { ProjectCommand } from './projectCommandsTypes.js';
import type { VibeConstraintRule } from './vibeConstraintsService.js';

export type SanitizerIssue =
	| { kind: 'zero-width-char'; field: 'command' | 'args' }
	| { kind: 'bidi-override'; field: 'command' | 'args' }
	| { kind: 'shell-metachar'; field: 'args'; arg: string }
	| { kind: 'cwd-outside-workspace'; resolvedCwd: string }
	| { kind: 'cwd-traversal'; cwdInput: string }
	| { kind: 'control-char'; field: 'command' | 'args' }
	| { kind: 'secret-in-env'; envKey: string }
	| { kind: 'constraint-denied'; rule: VibeConstraintRule };

// Secret-key heuristics: names that strongly suggest credentials / tokens.
// Matches env var keys whose names contain these substrings (case-insensitive).
const SECRET_KEY_PATTERNS = [
	'secret', 'token', 'password', 'passwd', 'api_key', 'apikey',
	'private_key', 'access_key', 'auth_key', 'bearer',
];

const SECRET_KEY_RE = new RegExp(SECRET_KEY_PATTERNS.join('|'), 'i');

/**
 * Minimal interface for checking constraints. The full IVibeConstraintsService
 * lives in vibeConstraintsService.ts (vscode-dependent). We accept this slim
 * interface so projectCommandsSanitizer stays vscode-free and testable.
 */
export interface IConstraintChecker {
	checkWriteAllowed(filePath: string): void;
}

export interface SanitizerResult {
	ok: boolean;
	issues: ReadonlyArray<SanitizerIssue>;
}

const ZERO_WIDTH_RE = /[​-‏﻿]/;
const BIDI_OVERRIDE_RE = /[‪-‮⁦-⁩]/;
// Carriage return / line feed / vertical tab / form feed / null / ESC (used by ANSI injection).
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f]/;
// Shell metacharacters that, without explicit shell:true, indicate the
// argument is trying to run something other than the literal binary.
const SHELL_META_RE = /[;&|`$<>(){}*?[\]!\\]/;

/**
 * Validate a Project Command for unsafe content. Pure. Returns all issues
 * found (caller decides whether to reject the import or just warn).
 */
export function sanitizeProjectCommand(cmd: ProjectCommand): SanitizerResult {
	const issues: SanitizerIssue[] = [];

	if (ZERO_WIDTH_RE.test(cmd.command)) {
		issues.push({ kind: 'zero-width-char', field: 'command' });
	}
	if (BIDI_OVERRIDE_RE.test(cmd.command)) {
		issues.push({ kind: 'bidi-override', field: 'command' });
	}
	if (CONTROL_RE.test(cmd.command)) {
		issues.push({ kind: 'control-char', field: 'command' });
	}

	if (cmd.args && cmd.args.length > 0) {
		const argsBlob = cmd.args.join(' ');
		if (ZERO_WIDTH_RE.test(argsBlob)) {
			issues.push({ kind: 'zero-width-char', field: 'args' });
		}
		if (BIDI_OVERRIDE_RE.test(argsBlob)) {
			issues.push({ kind: 'bidi-override', field: 'args' });
		}
		if (CONTROL_RE.test(argsBlob)) {
			issues.push({ kind: 'control-char', field: 'args' });
		}
		if (cmd.shell !== true) {
			for (const a of cmd.args) {
				if (SHELL_META_RE.test(a)) {
					issues.push({ kind: 'shell-metachar', field: 'args', arg: a });
				}
			}
		}
	}

	return { ok: issues.length === 0, issues };
}

/**
 * Check the resolved cwd is within the workspace root. Pure — caller is
 * responsible for resolving symlinks (`fs.realpath`) before passing the
 * absolute paths here. Both inputs MUST be absolute and normalised; this
 * function does the prefix containment check only.
 */
export function checkCwdWithinWorkspace(
	resolvedCwd: string,
	resolvedWorkspaceRoot: string,
): SanitizerIssue | null {
	if (typeof resolvedCwd !== 'string' || typeof resolvedWorkspaceRoot !== 'string') {
		return { kind: 'cwd-outside-workspace', resolvedCwd: String(resolvedCwd) };
	}
	const cwd = resolvedCwd.replace(/\\/g, '/').replace(/\/+$/, '');
	const root = resolvedWorkspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
	if (cwd === root) { return null; }
	if (cwd.startsWith(root + '/')) { return null; }
	return { kind: 'cwd-outside-workspace', resolvedCwd };
}

/**
 * Detect path-traversal-style cwd inputs (`..`, absolute outside workspace).
 * Pure — works on the raw string from the .vibe/commands.json file before
 * any path resolution. This is the cheap upfront filter; pair with
 * `checkCwdWithinWorkspace` for the post-realpath check.
 */
export function checkCwdTraversal(rawCwd: string): SanitizerIssue | null {
	if (typeof rawCwd !== 'string') {
		return { kind: 'cwd-traversal', cwdInput: String(rawCwd) };
	}
	const segments = rawCwd.replace(/\\/g, '/').split('/').filter(s => s.length > 0);
	if (segments.includes('..')) {
		return { kind: 'cwd-traversal', cwdInput: rawCwd };
	}
	return null;
}

/**
 * Scan the `env` map of a ProjectCommand for keys that look like secrets.
 * Pure — caller has already loaded the command from `.vibe/commands.json`.
 * Only key names are inspected; values are never logged or returned to avoid
 * leaking credentials into doctor output or CI logs.
 */
export function scanEnvForSecrets(cmd: ProjectCommand): SanitizerIssue[] {
	if (!cmd.env || typeof cmd.env !== 'object') { return []; }
	const issues: SanitizerIssue[] = [];
	for (const key of Object.keys(cmd.env)) {
		if (SECRET_KEY_RE.test(key)) {
			issues.push({ kind: 'secret-in-env', envKey: key });
		}
	}
	return issues;
}

/**
 * Validate a Project Command against workspace constraints. Pure from the
 * caller's perspective — all IO is done by the injected `checker`.
 * Catches `ConstraintViolationError` thrown by `checkWriteAllowed` and
 * converts it to a `SanitizerIssue`. The `cwd` field is the only path that
 * could target a protected area at import time; the command binary itself
 * is not path-checked here (it runs at execution time).
 */
export function checkCommandConstraints(
	cmd: ProjectCommand,
	checker: IConstraintChecker,
): SanitizerIssue[] {
	const issues: SanitizerIssue[] = [];
	if (cmd.cwd) {
		try {
			checker.checkWriteAllowed(cmd.cwd);
		} catch (e: unknown) {
			const rule = (e as { constraint?: VibeConstraintRule }).constraint;
			if (rule) {
				issues.push({ kind: 'constraint-denied', rule });
			}
		}
	}
	return issues;
}

/**
 * Build the human-readable text shown in the import preview / palette
 * confirmation dialog. Pure — caller injects this into a Quick Pick / toast.
 */
export function describeIssue(issue: SanitizerIssue): string {
	switch (issue.kind) {
		case 'zero-width-char':
			return `Field \`${issue.field}\` contains zero-width characters (paste injection guard).`;
		case 'bidi-override':
			return `Field \`${issue.field}\` contains Bidi-override characters.`;
		case 'control-char':
			return `Field \`${issue.field}\` contains ASCII control characters.`;
		case 'shell-metachar':
			return `Argument "${issue.arg}" contains shell metacharacters; set \`shell: true\` if intended.`;
		case 'cwd-outside-workspace':
			return `Resolved cwd \`${issue.resolvedCwd}\` is outside the workspace root.`;
		case 'cwd-traversal':
			return `cwd \`${issue.cwdInput}\` contains path-traversal segments (..).`;
		case 'secret-in-env':
			return `env key "${issue.envKey}" looks like a credential — store secrets in OS env or a secrets manager, not in .vibe/commands.json.`;
		case 'constraint-denied':
			return `Command cwd is denied by constraint rule: ${issue.rule.message ?? JSON.stringify(issue.rule)}.`;
	}
}
