/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `.vibe/servers.json` — the project's dev stack, checked into the repository (JSONC; comments
 * allowed). Describes every service a monorepo needs running at once, so a checkout replaces the
 * hand-rolled `dev.sh` most stacks grow.
 *
 * This module is the pure data layer: TypeScript types (which double as the canonical schema doc),
 * parsing, structural validation (a malformed entry is skipped, never crashes the file) and the
 * dependency ordering. No I/O, no process spawning — the service reads the file and drives the
 * runtimes. Keeping this layer pure makes the format testable from `test/common/`.
 *
 * ABSENT FILE = TODAY'S BEHAVIOUR. A project without `.vibe/servers.json` keeps the single
 * auto-detected server and the existing `vibeide.vibeServer.*` settings; nothing here runs.
 */

import { safeParseConfigJson } from '../vibeConfigJsonParser.js';

/**
 * `service` — a long-running process (dev server) that stays up until stopped.
 * `task` — a one-shot command that must succeed *before* its dependants start (docker daemon,
 * migrations, codegen). Modelling a prerequisite as data is what keeps tool-specific knowledge
 * (colima, minikube, compose) out of the IDE.
 */
export type VibeServerEntryKind = 'service' | 'task';

/**
 * How readiness is decided. A spawned process is not a ready one — Angular takes minutes before
 * it accepts connections, which is why `port` (socket accepts) is the default for services rather
 * than "the process did not exit".
 */
export type VibeServerReadyCheck =
	/** TCP connect to `port` succeeds. */
	| 'port'
	/** HTTP GET on `readyPath` returns a non-5xx status. */
	| 'http'
	/** `readyPattern` matches a line of the process output. */
	| 'log'
	/** Process exits with code 0 — the only meaningful check for a task. */
	| 'exit'
	/** Ready the moment it is spawned (fire-and-forget helpers). */
	| 'spawn';

/** Default readiness timeout; overridden per entry via `readyTimeoutMs`. */
export const DEFAULT_READY_TIMEOUT_MS = 60_000;

export interface VibeServerEntry {
	/** Unique key within the file. Used by `dependsOn`, commands, logs and UI. */
	readonly id: string;
	readonly name?: string;
	/** Default `service`. */
	readonly kind?: VibeServerEntryKind;
	/** Default true. `false` keeps the entry documented but out of the stack. */
	readonly active?: boolean;

	/** Working directory, relative to the workspace root. Defaults to the root itself. */
	readonly dir?: string;
	/** Command line to run (required). Executed through the platform shell. */
	readonly command: string;

	/**
	 * Port the service listens on. Declared rather than scraped from stdout: the single-server path
	 * parses the URL out of dev-server output, which cannot work when three of them start at once.
	 */
	readonly port?: number;
	readonly readyCheck?: VibeServerReadyCheck;
	/** Path probed when `readyCheck: 'http'`. Defaults to `/`. */
	readonly readyPath?: string;
	/** Regex source matched against output when `readyCheck: 'log'`. */
	readonly readyPattern?: string;
	readonly readyTimeoutMs?: number;

	/** Ids that must be ready before this entry starts. Unknown ids disable the entry. */
	readonly dependsOn?: readonly string[];
	/**
	 * Skip the entry when this probe command exits 0 — "already running, nothing to do"
	 * (e.g. `docker info` before `colima start`). Only meaningful for tasks.
	 */
	readonly skipIf?: string;

	readonly env?: Readonly<Record<string, string>>;
	/** Env file relative to `dir`, e.g. `.env.local`. */
	readonly envFile?: string;
	/** Directories prepended to `PATH` — pins a toolchain (`/opt/homebrew/opt/node@20/bin`). */
	readonly pathPrepend?: readonly string[];

	/** Start with the project. Gated on the command-trust confirmation. */
	readonly autoStart?: boolean;
	/** Path opened in preview instead of `/`. */
	readonly previewPath?: string;
	/** Extra command run on stop (`docker compose down`). Best-effort; failure is not fatal. */
	readonly stopCommand?: string;
	readonly note?: string;
}

export interface VibeServersFile {
	readonly version?: number;
	readonly servers: readonly VibeServerEntry[];
}

export interface VibeServersParseResult {
	readonly ok: boolean;
	/** Top-level failure (not JSON, no `servers` array). `undefined` on success. */
	readonly error?: string;
	readonly servers: readonly VibeServerEntry[];
	/** Non-fatal issues — skipped entries, dropped duplicates, broken dependencies. */
	readonly warnings: readonly string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const READY_CHECKS: readonly VibeServerReadyCheck[] = ['port', 'http', 'log', 'exit', 'spawn'];

/** Readiness fallback: a task is done when it exits, a service when its port accepts. */
export function effectiveReadyCheck(entry: VibeServerEntry): VibeServerReadyCheck {
	if (entry.readyCheck) { return entry.readyCheck; }
	if ((entry.kind ?? 'service') === 'task') { return 'exit'; }
	return typeof entry.port === 'number' ? 'port' : 'spawn';
}

export function effectiveReadyTimeoutMs(entry: VibeServerEntry): number {
	return typeof entry.readyTimeoutMs === 'number' && entry.readyTimeoutMs > 0
		? entry.readyTimeoutMs
		: DEFAULT_READY_TIMEOUT_MS;
}

/** Validate one raw entry. Returns the entry, or a reason string explaining why it was skipped. */
function validateEntry(raw: unknown, index: number): VibeServerEntry | string {
	if (!isObject(raw)) { return `запись #${index + 1}: не объект — пропущена`; }

	const id = typeof raw.id === 'string' ? raw.id.trim() : '';
	if (!id) { return `запись #${index + 1}: отсутствует "id" — пропущена`; }

	const command = typeof raw.command === 'string' ? raw.command.trim() : '';
	if (!command) { return `"${id}": отсутствует "command" — пропущена`; }

	const kind: VibeServerEntryKind = raw.kind === 'task' ? 'task' : 'service';

	const readyCheck = typeof raw.readyCheck === 'string' && READY_CHECKS.includes(raw.readyCheck as VibeServerReadyCheck)
		? raw.readyCheck as VibeServerReadyCheck
		: undefined;

	// A port-gated readiness check without a port can never resolve — fail loudly at parse time
	// rather than hanging until the timeout expires.
	const port = typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536
		? raw.port
		: undefined;
	if (readyCheck === 'port' && port === undefined) {
		return `"${id}": readyCheck "port" требует поля "port" — пропущена`;
	}
	if (readyCheck === 'log' && typeof raw.readyPattern !== 'string') {
		return `"${id}": readyCheck "log" требует поля "readyPattern" — пропущена`;
	}

	const dependsOn = Array.isArray(raw.dependsOn)
		? raw.dependsOn.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).map(d => d.trim())
		: undefined;

	const pathPrepend = Array.isArray(raw.pathPrepend)
		? raw.pathPrepend.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
		: undefined;

	const env = isObject(raw.env)
		? Object.fromEntries(Object.entries(raw.env).filter((e): e is [string, string] => typeof e[1] === 'string'))
		: undefined;

	const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);

	return {
		id,
		name: str(raw.name),
		kind,
		active: raw.active === false ? false : true,
		dir: str(raw.dir),
		command,
		port,
		readyCheck,
		readyPath: str(raw.readyPath),
		readyPattern: typeof raw.readyPattern === 'string' ? raw.readyPattern : undefined,
		readyTimeoutMs: typeof raw.readyTimeoutMs === 'number' && raw.readyTimeoutMs > 0 ? raw.readyTimeoutMs : undefined,
		dependsOn: dependsOn?.length ? dependsOn : undefined,
		skipIf: str(raw.skipIf),
		env: env && Object.keys(env).length ? env : undefined,
		envFile: str(raw.envFile),
		pathPrepend: pathPrepend?.length ? pathPrepend : undefined,
		autoStart: raw.autoStart === true,
		previewPath: str(raw.previewPath),
		stopCommand: str(raw.stopCommand),
		note: str(raw.note),
	};
}

/**
 * Parse + structurally validate a `.vibe/servers.json`. JSONC comments are tolerated. Individual
 * malformed entries are skipped (recorded in `warnings`) so one typo doesn't disable the whole
 * stack; a top-level problem returns `ok:false` and no servers.
 */
export function parseServersFile(raw: string | undefined | null): VibeServersParseResult {
	const parsed = safeParseConfigJson(raw);
	if (!parsed.ok) {
		return { ok: false, error: parsed.reason, servers: [], warnings: [] };
	}
	const root = parsed.value;
	if (!isObject(root) || !Array.isArray(root.servers)) {
		return { ok: false, error: 'ожидался объект с массивом "servers"', servers: [], warnings: [] };
	}

	const servers: VibeServerEntry[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < root.servers.length; i++) {
		const result = validateEntry(root.servers[i], i);
		if (typeof result === 'string') {
			warnings.push(result);
			continue;
		}
		if (seen.has(result.id)) {
			warnings.push(`"${result.id}": повтор id — пропущена`);
			continue;
		}
		seen.add(result.id);
		servers.push(result);
	}

	return { ok: true, servers, warnings };
}

export interface VibeServerStartPlan {
	/**
	 * Waves of entry ids. Everything inside one wave may start in parallel; the next wave waits for
	 * the previous to report ready. Order comes from `dependsOn`, not from the order in the file.
	 */
	readonly waves: readonly (readonly string[])[];
	/** Entries excluded from the plan, with the reason (unknown dependency, dependency cycle). */
	readonly excluded: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * Order entries into parallel start waves (Kahn's algorithm).
 *
 * An entry whose dependency is unknown or inactive is EXCLUDED rather than started early: silently
 * dropping the edge would launch a service without its prerequisite, which is exactly the failure
 * the dependency was written to prevent. Exclusion is transitive — dependants of an excluded entry
 * are excluded too, for the same reason.
 */
export function planStartOrder(servers: readonly VibeServerEntry[]): VibeServerStartPlan {
	const active = servers.filter(s => s.active !== false);
	const byId = new Map(active.map(s => [s.id, s]));
	const excluded: { id: string; reason: string }[] = [];

	// Drop entries with dependencies that cannot ever be satisfied, then cascade to their dependants.
	const usable = new Map(byId);
	for (let changed = true; changed;) {
		changed = false;
		for (const [id, entry] of usable) {
			const missing = entry.dependsOn?.find(d => !usable.has(d));
			if (missing !== undefined) {
				usable.delete(id);
				excluded.push({
					id,
					reason: byId.has(missing)
						? `зависит от "${missing}", который исключён`
						: `зависит от неизвестного сервиса "${missing}"`,
				});
				changed = true;
			}
		}
	}

	const waves: string[][] = [];
	const started = new Set<string>();
	const pending = new Map(usable);

	while (pending.size > 0) {
		const wave = [...pending.values()]
			.filter(e => (e.dependsOn ?? []).every(d => started.has(d)))
			.map(e => e.id);

		if (wave.length === 0) {
			// Nothing can start: every survivor waits on another survivor — a cycle.
			for (const id of pending.keys()) {
				excluded.push({ id, reason: 'циклическая зависимость' });
			}
			break;
		}

		for (const id of wave) {
			pending.delete(id);
			started.add(id);
		}
		waves.push(wave);
	}

	return { waves, excluded };
}

/**
 * Narrow the stack to a single target and everything it transitively needs, so starting one entry
 * pulls in exactly its prerequisites — no more (siblings stay untouched), no less (a service never
 * comes up without its dependencies).
 *
 * Returns entries in file order; feed the result to `planStartOrder` to get the start waves. An
 * unknown `targetId` yields an empty selection. Missing/inactive dependencies are deliberately left
 * out of the selection: `planStartOrder` then excludes the target for the same reason a full-stack
 * plan would, keeping the "never start without a prerequisite" guarantee identical on both paths.
 */
export function selectWithDependencies(servers: readonly VibeServerEntry[], targetId: string): readonly VibeServerEntry[] {
	const byId = new Map(servers.map(s => [s.id, s]));
	const target = byId.get(targetId);
	if (!target) {
		return [];
	}
	const picked = new Map<string, VibeServerEntry>();
	const queue: VibeServerEntry[] = [target];
	while (queue.length > 0) {
		const entry = queue.shift()!;
		if (picked.has(entry.id)) {
			continue;
		}
		picked.set(entry.id, entry);
		for (const dep of entry.dependsOn ?? []) {
			const resolved = byId.get(dep);
			if (resolved && !picked.has(dep)) {
				queue.push(resolved);
			}
		}
	}
	// Preserve the file order so diagnostics and logs read predictably.
	return servers.filter(s => picked.has(s.id));
}
