/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — secret-aware placeholder resolver (pure helper).
 *
 * K.2 line 917 — `command` / `args` / `env` strings should accept `${env:NAME}` and
 * `${secret:KEY}` placeholders instead of literal secrets, so users can keep tokens
 * out of `.vibe/commands.json`. Today the only protection is a community-import
 * sanitiser; nothing prevents a maintainer from typing an API key into `command`
 * and committing it.
 *
 * Adoption order:
 *   1. `IVibeCustomCommandsService` runs `resolveProjectCommandSecrets(cmd, env, secret)`
 *      before spawning the process: env reads `process.env`, secret reads
 *      `IEncryptionService.getSecret`.
 *   2. If `unresolved.length > 0` the service refuses to run and shows a banner
 *      listing the missing keys (no value leaks — only the placeholder names).
 *   3. The `redactedForAudit` field carries a version where every resolved value is
 *      replaced with `[REDACTED]`, suitable for `audit_command_executed` payloads.
 *
 * vscode-free: no imports.
 */

export type SecretLookupKind = 'env' | 'secret';

export interface SecretLookups {
	readonly env: (name: string) => string | undefined;
	readonly secret: (key: string) => string | undefined;
}

export interface UnresolvedPlaceholder {
	readonly kind: SecretLookupKind;
	readonly name: string;
	/** Where the placeholder appeared, for caller-side error attribution. */
	readonly field: 'command' | 'args' | 'cwd' | 'env';
	/** Index into args / env key, when applicable. */
	readonly index?: number | string;
}

export interface ResolvedProjectCommand {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string | undefined;
	readonly env: Readonly<Record<string, string>>;
}

export interface ResolveResult {
	readonly resolved: ResolvedProjectCommand;
	readonly redactedForAudit: ResolvedProjectCommand;
	readonly unresolved: readonly UnresolvedPlaceholder[];
	readonly resolutionsCount: number;
}

export interface ResolverInput {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

/**
 * Public regexes for tests + the form-based editor live-validation. The grammar
 * is `${env:WORD}` and `${secret:WORD}` where WORD = `[A-Za-z0-9_.-]+`. No
 * default-fallback syntax (`${env:NAME-default}`) — keep the surface tight; if
 * users want fallbacks, they can build the string with shell substitution.
 */
export const PLACEHOLDER_RE = /\$\{(env|secret):([A-Za-z0-9_.\-]+)\}/g;

/**
 * Pure: resolves placeholders in a single string. Returns the resolved text and
 * a list of unresolved placeholders. Used internally; exposed for unit testing.
 */
export function resolveStringPlaceholders(
	input: string,
	field: UnresolvedPlaceholder['field'],
	index: number | string | undefined,
	lookups: SecretLookups,
	collector: UnresolvedPlaceholder[],
): { resolved: string; redacted: string; resolvedCount: number } {
	let resolvedCount = 0;
	const redactedParts: string[] = [];
	let lastEnd = 0;
	let resolvedOut = '';
	const re = new RegExp(PLACEHOLDER_RE.source, 'g');
	for (let m = re.exec(input); m !== null; m = re.exec(input)) {
		const literal = input.slice(lastEnd, m.index);
		resolvedOut += literal;
		redactedParts.push(literal);
		const kind = m[1] as SecretLookupKind;
		const name = m[2];
		const value = kind === 'env' ? lookups.env(name) : lookups.secret(name);
		if (value === undefined) {
			collector.push({ kind, name, field, ...(index !== undefined ? { index } : {}) });
			// On unresolved, leave the original placeholder in the resolved text and the
			// redacted text — caller refuses to spawn anyway, so this string is not used
			// at runtime; preserving the placeholder helps the banner explain itself.
			resolvedOut += m[0];
			redactedParts.push(m[0]);
		} else {
			resolvedCount++;
			resolvedOut += value;
			redactedParts.push('[REDACTED]');
		}
		lastEnd = m.index + m[0].length;
	}
	const tail = input.slice(lastEnd);
	resolvedOut += tail;
	redactedParts.push(tail);
	return { resolved: resolvedOut, redacted: redactedParts.join(''), resolvedCount };
}

/**
 * Pure: resolves placeholders across the whole command shape. Never throws.
 * Caller must check `unresolved.length === 0` before spawning.
 */
export function resolveProjectCommandSecrets(input: ResolverInput, lookups: SecretLookups): ResolveResult {
	const unresolved: UnresolvedPlaceholder[] = [];
	let resolutionsCount = 0;

	const cmd = resolveStringPlaceholders(input.command, 'command', undefined, lookups, unresolved);
	resolutionsCount += cmd.resolvedCount;

	const args: string[] = [];
	const argsRedacted: string[] = [];
	if (input.args) {
		for (let i = 0; i < input.args.length; i++) {
			const r = resolveStringPlaceholders(input.args[i], 'args', i, lookups, unresolved);
			args.push(r.resolved);
			argsRedacted.push(r.redacted);
			resolutionsCount += r.resolvedCount;
		}
	}

	let cwdResolved: string | undefined;
	let cwdRedacted: string | undefined;
	if (input.cwd) {
		const r = resolveStringPlaceholders(input.cwd, 'cwd', undefined, lookups, unresolved);
		cwdResolved = r.resolved;
		cwdRedacted = r.redacted;
		resolutionsCount += r.resolvedCount;
	}

	const env: Record<string, string> = {};
	const envRedacted: Record<string, string> = {};
	if (input.env) {
		for (const [k, v] of Object.entries(input.env)) {
			const r = resolveStringPlaceholders(v, 'env', k, lookups, unresolved);
			env[k] = r.resolved;
			envRedacted[k] = r.redacted;
			resolutionsCount += r.resolvedCount;
		}
	}

	return {
		resolved: { command: cmd.resolved, args, cwd: cwdResolved, env },
		redactedForAudit: { command: cmd.redacted, args: argsRedacted, cwd: cwdRedacted, env: envRedacted },
		unresolved,
		resolutionsCount,
	};
}

/**
 * Pure: builds a Russian banner body listing unresolved placeholders by field.
 * Never includes resolved values — only placeholder names — so banner copy is
 * safe to log.
 */
export function describeUnresolvedPlaceholders(unresolved: readonly UnresolvedPlaceholder[]): string {
	if (unresolved.length === 0) { return ''; }
	const lines = ['Команда не запущена — следующие плейсхолдеры не разрешены:'];
	for (const u of unresolved) {
		const where = u.index !== undefined ? `${u.field}[${u.index}]` : u.field;
		lines.push(`  • \${${u.kind}:${u.name}} в ${where}`);
	}
	lines.push('');
	lines.push('Заполните `process.env` (для env:) или сохраните секрет через VibeIDE Settings → Secrets (для secret:).');
	return lines.join('\n');
}

/**
 * Pure: scans for plaintext-looking secrets in command/args/env values WITHOUT
 * placeholders. Heuristic — flags strings that look like API tokens (length ≥ 32,
 * mixed case + digits, no spaces). For use during edit/import flow before the
 * user saves; complements `ISecretDetectionService` for VibeIDE's dedicated
 * patterns. Returns a per-field list of suspect strings (without the values
 * themselves — only field paths).
 */
export function findSuspiciousLiteralSecrets(input: ResolverInput): readonly { field: string; pathHint: string }[] {
	const out: { field: string; pathHint: string }[] = [];
	const checks: { value: string; field: string; pathHint: string }[] = [
		{ value: input.command, field: 'command', pathHint: 'command' },
	];
	if (input.args) {
		input.args.forEach((v, i) => checks.push({ value: v, field: 'args', pathHint: `args[${i}]` }));
	}
	if (input.env) {
		for (const [k, v] of Object.entries(input.env)) {
			checks.push({ value: v, field: 'env', pathHint: `env.${k}` });
		}
	}
	for (const c of checks) {
		// A command/arg value is usually a whole command line ("curl … token=ghp_…"),
		// so scan each whitespace-separated token — a single embedded key must still
		// be caught even though the field as a whole contains spaces.
		if (c.value.split(/\s+/).some(looksLikeSecret)) {
			out.push({ field: c.field, pathHint: c.pathHint });
		}
	}
	return out;
}

function looksLikeSecret(s: string): boolean {
	if (typeof s !== 'string' || s.length < 32) { return false; }
	// Skip strings that are mostly placeholders — the resolver handles those.
	if (PLACEHOLDER_RE.test(s)) {
		PLACEHOLDER_RE.lastIndex = 0;
		return false;
	}
	if (/\s/.test(s)) { return false; }
	const hasLower = /[a-z]/.test(s);
	const hasUpper = /[A-Z]/.test(s);
	const hasDigit = /[0-9]/.test(s);
	const hasSpecial = /[._\-+/=]/.test(s);
	const variety = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
	return variety >= 3;
}
