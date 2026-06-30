/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — CLI argv decoder + `vibe doctor` validator
 * (roadmap §"CLI, doctor и audit":
 *  - `vibe commands list --json` / `vibe commands run <id>` — argv decoder;
 *  - `vibe doctor` validates schema / slugs / duplicate ids / missing command;
 *    `--repair` writes back `vibeVersion` if absent).
 *
 * Pure helpers — no `fs` / `process` / `vscode` imports — so the argv parser
 * and the audit can be unit-tested without touching disk. Caller injects the
 * loaded `.vibe/commands.json` content as `unknown` and the helper returns a
 * tagged result with all issues collected.
 */

import {
	ProjectCommand,
	ProjectCommandsFile,
	PROJECT_COMMAND_ID_PATTERN,
	decodeProjectCommandsFile,
} from './projectCommandsTypes.js';

// -----------------------------------------------------------------------------
// vibe commands list / run — argv decoder
// -----------------------------------------------------------------------------

export type ProjectCommandsCliInvocation =
	| { readonly kind: 'list'; readonly json: boolean }
	| { readonly kind: 'run'; readonly id: string }
	| { readonly kind: 'help' }
	| { readonly kind: 'error'; readonly reason: string };

/**
 * Decode an `argv` slice already past `vibe commands`. Caller is expected to
 * have stripped `node`, the script path, and the `commands` subcommand name —
 * helper sees only what the user typed *after* `vibe commands`.
 *
 * Examples:
 *   []                          → list (default subcommand)
 *   ['list']                    → list
 *   ['list', '--json']          → list json=true
 *   ['run', 'build-react']      → run id=build-react
 *   ['run']                     → error 'run-needs-id'
 *   ['run', 'BAD ID']           → error 'invalid-id'
 *   ['--help'] / ['-h']         → help
 *   ['nonsense']                → error 'unknown-subcommand'
 */
export function decodeProjectCommandsCli(argv: ReadonlyArray<string>): ProjectCommandsCliInvocation {
	if (argv.length === 0) {
		return { kind: 'list', json: false };
	}
	const head = argv[0];
	if (head === '--help' || head === '-h' || head === 'help') {
		return { kind: 'help' };
	}
	if (head === 'list') {
		const json = argv.slice(1).includes('--json');
		const unknown = argv.slice(1).find(a => a !== '--json');
		if (unknown !== undefined) {
			return { kind: 'error', reason: `unknown-flag:${unknown}` };
		}
		return { kind: 'list', json };
	}
	if (head === 'run') {
		const id = argv[1];
		if (id === undefined || id === '') {
			return { kind: 'error', reason: 'run-needs-id' };
		}
		if (!PROJECT_COMMAND_ID_PATTERN.test(id)) {
			return { kind: 'error', reason: 'invalid-id' };
		}
		if (argv.length > 2) {
			return { kind: 'error', reason: `run-extra-args:${argv.slice(2).join(' ')}` };
		}
		return { kind: 'run', id };
	}
	return { kind: 'error', reason: 'unknown-subcommand' };
}

// -----------------------------------------------------------------------------
// vibe doctor — commands schema audit
// -----------------------------------------------------------------------------

export type DoctorIssueCode =
	| 'file-decode-failed'
	| 'duplicate-id'
	| 'missing-command'
	| 'invalid-id-pattern'
	| 'missing-vibe-version'
	| 'legacy-dollar-id';

export interface DoctorIssue {
	readonly code: DoctorIssueCode;
	readonly id?: string;
	readonly message: string;
}

export interface DoctorAuditResult {
	readonly issues: readonly DoctorIssue[];
	readonly file: ProjectCommandsFile | null;
}

export interface DoctorRepairResult {
	readonly repaired: boolean;
	readonly nextRaw: unknown;
	readonly notes: readonly string[];
}

/**
 * Pure: collect-all-issues audit for `.vibe/commands.json`.
 *
 *   - file-decode-failed   → entire file rejected; `file` is null.
 *   - duplicate-id         → reported by the decoder but also listed here for
 *                            `vibe doctor` UX (one issue per duplicate).
 *   - missing-command      → `command` field empty (decoder also catches it,
 *                            but separated into its own issue for repair UX).
 *   - invalid-id-pattern   → id violates PROJECT_COMMAND_ID_PATTERN (decoder
 *                            also catches; surfaced here per command).
 *   - missing-vibe-version → schema field missing/empty; `--repair` fixes it.
 *
 * If the decoder rejects the file, only `file-decode-failed` is reported —
 * the per-command checks need a typed payload to walk over.
 */
export function auditProjectCommandsForDoctor(raw: unknown): DoctorAuditResult {
	const issues: DoctorIssue[] = [];

	// L305: peek for legacy `$id` keys — older `.vibe/commands.json` files used
	// JSON-Schema-style `$id`. The strict decoder treats them as missing `id`
	// (decode fails). Surface a per-command issue so `--repair` can migrate.
	const legacyIds = collectLegacyDollarIds(raw);
	for (const legacyId of legacyIds) {
		issues.push({
			code: 'legacy-dollar-id',
			id: legacyId,
			message: `command uses legacy "$id" key — run \`vibe doctor --repair\` to rename to "id"`,
		});
	}
	if (legacyIds.length > 0) {
		// Decoder will reject these — but report only the legacy-id issue (not
		// a confusing file-decode-failed on top). The repaired output reruns
		// audit and surfaces any remaining real issues.
		return { issues, file: null };
	}

	const decoded = decodeProjectCommandsFile(raw);

	if (!decoded.ok) {
		issues.push({
			code: 'file-decode-failed',
			message: `decoder reason: ${decoded.reason}`,
		});
		return { issues, file: null };
	}

	const file = decoded.value;

	if (typeof file.vibeVersion !== 'string' || file.vibeVersion.length === 0) {
		issues.push({ code: 'missing-vibe-version', message: 'vibeVersion is missing or empty' });
	}

	const seen = new Map<string, number>();
	for (const c of file.commands) {
		const seenAt = seen.get(c.id);
		if (seenAt !== undefined) {
			issues.push({ code: 'duplicate-id', id: c.id, message: `duplicate id at index ${seenAt} and later` });
		} else {
			seen.set(c.id, file.commands.indexOf(c));
		}
		if (!PROJECT_COMMAND_ID_PATTERN.test(c.id)) {
			issues.push({ code: 'invalid-id-pattern', id: c.id, message: `id does not match ${PROJECT_COMMAND_ID_PATTERN.source}` });
		}
		if (typeof c.command !== 'string' || c.command.length === 0) {
			issues.push({ code: 'missing-command', id: c.id, message: 'command field is empty' });
		}
	}

	return { issues, file };
}

/**
 * `vibe doctor --repair` — currently only repairs `missing-vibe-version` by
 * inserting the supplied `vibeVersion` value. All other issues require human
 * judgement (which duplicate to keep, which command body is correct).
 *
 * Returns a fresh `nextRaw` object (never mutates input) plus a list of
 * human-readable notes describing what was changed.
 */
export function repairProjectCommandsForDoctor(raw: unknown, vibeVersion: string): DoctorRepairResult {
	const notes: string[] = [];
	if (raw === null || typeof raw !== 'object') {
		return { repaired: false, nextRaw: raw, notes: ['file shape is not an object — manual fix required'] };
	}
	const obj = raw as Record<string, unknown>;
	const next: Record<string, unknown> = { ...obj };
	if (typeof next.vibeVersion !== 'string' || (next.vibeVersion as string).length === 0) {
		next.vibeVersion = vibeVersion;
		notes.push(`inserted vibeVersion=${vibeVersion}`);
	}
	// L305: migrate legacy `$id` → `id` for each command entry. Older docs used
	// JSON-Schema-style `$id`; the strict decoder requires plain `id`. Skip
	// entries that already carry a non-empty `id` to avoid clobbering manual
	// fixes during a mixed-shape rollout.
	if (Array.isArray(next.commands)) {
		const migrated: unknown[] = [];
		let migratedCount = 0;
		for (const item of next.commands) {
			if (item && typeof item === 'object' && !Array.isArray(item)) {
				const cmdObj = { ...(item as Record<string, unknown>) };
				const legacy = cmdObj['$id'];
				const current = cmdObj['id'];
				if (typeof legacy === 'string' && legacy.length > 0
					&& (typeof current !== 'string' || (current as string).length === 0)) {
					cmdObj['id'] = legacy;
					delete cmdObj['$id'];
					migratedCount++;
				} else if (typeof legacy === 'string' && legacy.length > 0) {
					// Both `$id` and `id` present — drop `$id` to clean up; keep `id`.
					delete cmdObj['$id'];
					migratedCount++;
				}
				migrated.push(cmdObj);
			} else {
				migrated.push(item);
			}
		}
		if (migratedCount > 0) {
			next.commands = migrated;
			notes.push(`migrated ${migratedCount} command(s) from legacy "$id" to "id"`);
		}
	}
	if (notes.length === 0) {
		return { repaired: false, nextRaw: raw, notes: ['no auto-repairable issues'] };
	}
	return { repaired: true, nextRaw: next, notes };
}

/**
 * Pure: collect ids of commands using legacy `$id`. Returns the value of
 * each `$id` as the id-for-reporting (since the decoder won't see `id`).
 */
function collectLegacyDollarIds(raw: unknown): string[] {
	if (raw === null || typeof raw !== 'object') { return []; }
	const commands = (raw as Record<string, unknown>).commands;
	if (!Array.isArray(commands)) { return []; }
	const out: string[] = [];
	for (const item of commands) {
		if (item && typeof item === 'object' && !Array.isArray(item)) {
			const legacy = (item as Record<string, unknown>)['$id'];
			const current = (item as Record<string, unknown>)['id'];
			if (typeof legacy === 'string' && legacy.length > 0
				&& (typeof current !== 'string' || (current as string).length === 0)) {
				out.push(legacy);
			}
		}
	}
	return out;
}

/**
 * Build a list-mode `--json` payload for `vibe commands list --json`. Pure —
 * caller passes the loaded file (or null when there is none). Only fields
 * useful to a CI pipeline are included; `env` values are deliberately omitted
 * to avoid leaking secrets through CI logs.
 */
export function buildCliListJsonPayload(file: ProjectCommandsFile | null): {
	readonly version: string;
	readonly count: number;
	readonly commands: readonly {
		readonly id: string;
		readonly name: string;
		readonly description?: string;
		readonly terminal: ProjectCommand['terminal'];
		readonly singleton: boolean;
		readonly pinned: boolean;
	}[];
} {
	if (file === null) {
		return { version: '0.0.0', count: 0, commands: [] };
	}
	return {
		version: file.vibeVersion,
		count: file.commands.length,
		commands: file.commands.map(c => ({
			id: c.id,
			name: c.name,
			...(c.description ? { description: c.description } : {}),
			terminal: c.terminal,
			singleton: c.singleton === true,
			pinned: c.pinned === true,
		})),
	};
}
