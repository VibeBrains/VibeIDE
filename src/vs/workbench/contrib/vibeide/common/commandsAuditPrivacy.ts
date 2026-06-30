/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — stealth / privacy redaction (pure helper).
 *
 * K.2 line 337 — when a project command runs, two privacy gaps need closing:
 *   1. Audit log MUST NOT record env values (only keys are safe).
 *   2. Cloud indexers (semantic search, embeddings, RAG) MUST NOT receive
 *      command body or env at all — id + name + description is enough for
 *      "which commands does this project define" without leaking secrets.
 *
 * The settings flags `vibeide.commands.audit` (audit log opt-in) and
 * `vibeide.commands.auditStdout` (full-stdout opt-in) gate which fields are
 * actually allowed; this helper takes care of producing the redacted shape
 * once the runtime decides what level of recording it wants.
 *
 * Adoption order:
 *   1. `IVibeCustomCommandsService.run(...)` calls `redactCommandForAudit(...)`
 *      with the resolved command (post-secret-substitution) + the user's audit
 *      flags; passes the result to the audit channel.
 *   2. The cloud-indexer entry point (RAG / search) calls
 *      `redactCommandForCloudIndex(...)` instead — same source, much tighter
 *      shape. Caller never has access to the raw command body.
 *   3. The `auditStdout` flag, when on, allows stdout/stderr to flow through
 *      `redactStreamForAudit` which only strips obvious secret-shaped lines.
 *
 * vscode-free.
 */

export interface ProjectCommandRunRecord {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly exitCode?: number;
	readonly durationMs?: number;
	readonly stdout?: string;
	readonly stderr?: string;
}

export interface AuditFlags {
	/** Master switch: false ⇒ no audit, return null. */
	readonly enabled: boolean;
	/** When true, stdout/stderr are included in the audit shape (still secret-redacted). */
	readonly includeStdout: boolean;
}

export interface CommandAuditShape {
	readonly id: string;
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	/** Env keys — NEVER values. Empty array if env was empty. */
	readonly envKeys: readonly string[];
	readonly exitCode?: number;
	readonly durationMs?: number;
	/** Only present when audit flag `includeStdout` is true. */
	readonly stdout?: string;
	readonly stderr?: string;
}

export interface CommandCloudIndexShape {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
}

/**
 * Pure: returns the audit-safe shape of a command run, or null when audit is
 * disabled. ENV VALUES ARE NEVER INCLUDED — only the key list. stdout/stderr
 * only flow when `flags.includeStdout` is on, and even then they pass through
 * `redactStreamForAudit` to strip obvious secret-shaped lines.
 */
export function redactCommandForAudit(
	record: ProjectCommandRunRecord,
	flags: AuditFlags,
): CommandAuditShape | null {
	if (!flags.enabled) { return null; }
	const envKeys = record.env ? Object.keys(record.env).sort() : [];
	return {
		id: record.id,
		name: record.name,
		command: record.command,
		args: record.args,
		...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
		envKeys,
		...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
		...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
		...(flags.includeStdout
			? {
				...(record.stdout !== undefined ? { stdout: redactStreamForAudit(record.stdout) } : {}),
				...(record.stderr !== undefined ? { stderr: redactStreamForAudit(record.stderr) } : {}),
			}
			: {}),
	};
}

/**
 * Pure: returns the cloud-indexer shape — id + name + description only. The
 * indexer NEVER sees the command body or env keys. If the indexer wants to
 * surface a command in search results, it has these three fields and a deep
 * link.
 */
export function redactCommandForCloudIndex(record: ProjectCommandRunRecord): CommandCloudIndexShape {
	return {
		id: record.id,
		name: record.name,
		...(record.description !== undefined ? { description: record.description } : {}),
	};
}

/**
 * Pure: line-by-line redactor for command stdout/stderr. Replaces lines that
 * look like a secret with `[REDACTED LINE]`. Heuristic — we drop any line that:
 *   - matches a known secret prefix (ghp_, sk-, sk-ant-, AKIA, eyJ for JWT),
 *   - contains `Authorization:` / `X-API-Key:` / `Cookie:` headers,
 *   - is ≥ 32 chars with ≥ 3 character-class variety AND no whitespace
 *     (matches `findSuspiciousLiteralSecrets` heuristic from
 *     `projectCommandSecretsResolver.ts`).
 *
 * Never modifies plain log lines. Returns the joined-up string with `\n`
 * separators preserved.
 */
export function redactStreamForAudit(stream: string): string {
	if (typeof stream !== 'string' || stream.length === 0) { return stream; }
	const lines = stream.split('\n');
	const redacted: string[] = [];
	for (const line of lines) {
		if (looksLikeSecretLine(line)) {
			redacted.push('[REDACTED LINE]');
		} else {
			redacted.push(line);
		}
	}
	return redacted.join('\n');
}

const SECRET_PREFIX_RE = /\b(?:ghp_|gho_|ghu_|ghs_|sk-(?:ant-)?[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]{15,})/;
const HEADER_RE = /(?:^|\s)(?:authorization|x-api-key|cookie|proxy-authorization|anthropic-api-key|x-aws-access-token):\s*\S+/i;

function looksLikeSecretLine(line: string): boolean {
	if (SECRET_PREFIX_RE.test(line)) { return true; }
	if (HEADER_RE.test(line)) { return true; }
	// Long-token heuristic: trim, check length + variety + no whitespace.
	const trimmed = line.trim();
	if (trimmed.length >= 32 && !/\s/.test(trimmed)) {
		const hasLower = /[a-z]/.test(trimmed);
		const hasUpper = /[A-Z]/.test(trimmed);
		const hasDigit = /[0-9]/.test(trimmed);
		const hasSpecial = /[._\-+/=]/.test(trimmed);
		const variety = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
		if (variety >= 3) { return true; }
	}
	return false;
}

/**
 * Pure: validates `auditFlags`-shaped settings input. Used at the settings
 * boundary so a malformed config doesn't accidentally enable a privacy gap.
 * `enabled` defaults to false (privacy-by-default); `includeStdout` defaults
 * to false even when `enabled` is true.
 */
export function decodeAuditFlags(raw: unknown): AuditFlags {
	if (!raw || typeof raw !== 'object') { return { enabled: false, includeStdout: false }; }
	const r = raw as Record<string, unknown>;
	return {
		enabled: r.enabled === true,
		includeStdout: r.includeStdout === true,
	};
}
