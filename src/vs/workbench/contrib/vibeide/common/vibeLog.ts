/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Single VibeIDE diagnostic logger — module-level singleton so it is reachable from
 * every context (browser/workbench, electron-main, common helpers, web workers, the
 * React bundle) without dependency injection.
 *
 * Every line is gated by THREE independent controls so console noise can be shaped
 * without deleting call sites:
 *   1. master on/off (`enabled`)
 *   2. level threshold (`off < error < warn < info < debug < trace`)
 *   3. category allowlist (empty = all; otherwise only listed categories pass)
 *
 * Configuration sources, in increasing precedence:
 *   - built-in defaults (below)
 *   - environment variables (`VIBE_LOG` / `VIBE_LOG_LEVEL` / `VIBE_LOG_CATEGORIES`),
 *     applied at module load — the ONLY control that reaches the electron-main /
 *     node processes, where the renderer settings bridge does not run.
 *   - live settings via `configure()` (renderer bridge — `vibeLogConfigContribution.ts`).
 *
 * Output is routed through the GLOBAL `console.*` (not a captured reference) on purpose:
 * the renderer wraps `console.*` for secret redaction (firstRunValidation), and we want
 * that wrapper to still apply to every logged line. A bounded in-memory ring buffer keeps
 * the last N passed lines for the "Copy Recent Logs" command (so diagnostics no longer
 * require digging through DevTools). The timestamp format is shared with `vibeTraceTs()`.
 */

import { vibeTraceTs } from './helpers/vibeTraceTs.js';
import { logCategoryAllowed, resolveCategoryLevelWildcard } from './logCategoryMatch.js';

export enum VibeLogLevel {
	Off = 0,
	Error = 1,
	Warn = 2,
	Info = 3,
	Debug = 4,
	Trace = 5,
}

export const LEVEL_NAMES = ['off', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type VibeLogLevelName = typeof LEVEL_NAMES[number];

export function vibeLogLevelFromName(name: string): VibeLogLevel {
	const idx = LEVEL_NAMES.indexOf(name.trim().toLowerCase() as VibeLogLevelName);
	return idx >= 0 ? (idx as VibeLogLevel) : VibeLogLevel.Debug;
}

interface VibeLogConfig {
	enabled: boolean;
	level: VibeLogLevel;
	categories: ReadonlySet<string> | null; // null = all categories pass
	categoryLevels: ReadonlyMap<string, VibeLogLevel>; // per-category threshold override; falls back to `level`
	timestamps: boolean;
	dedupe: boolean; // collapse consecutive identical lines
}

// Defaults: ON at `debug` for development. Flip via `vibeide.logging.*` settings (or
// the `VIBE_LOG*` env vars) to silence output without removing call sites from the code.
const config: VibeLogConfig = {
	enabled: true,
	level: VibeLogLevel.Debug,
	categories: null,
	categoryLevels: new Map(),
	timestamps: true,
	dedupe: true,
};

export interface VibeLogEntry {
	readonly atMs: number;
	readonly ts: string;
	readonly level: VibeLogLevelName;
	readonly category: string;
	readonly msg: string;
}

const DEFAULT_BUFFER_SIZE = 500;
const MAX_BUFFER_SIZE = 10000;
let bufferSize = DEFAULT_BUFFER_SIZE;
const buffer: VibeLogEntry[] = [];
const knownCats = new Set<string>();

function safeStr(a: unknown): string {
	if (typeof a === 'string') { return a; }
	if (a instanceof Error) { return a.stack || `${a.name}: ${a.message}`; }
	if (a === undefined) { return 'undefined'; }
	try { return JSON.stringify(a); } catch { return String(a); }
}

function passes(level: VibeLogLevel, category: string): boolean {
	if (!config.enabled) { return false; }
	// A per-category threshold overrides the global level for that category only; everything else
	// uses `config.level`. Exact key first (O(1)); on a miss, a `prefix*` wildcard key may apply
	// (roadmap #3115 — group ~150 flat categories without listing each one).
	let threshold = config.categoryLevels.get(category);
	if (threshold === undefined && config.categoryLevels.size > 0) {
		const wildKey = resolveCategoryLevelWildcard(category, config.categoryLevels.keys());
		if (wildKey !== undefined) { threshold = config.categoryLevels.get(wildKey); }
	}
	if (level > (threshold ?? config.level)) { return false; }
	// Allowlist (empty/null = all). Supports exact names and `prefix*` wildcards.
	if (!logCategoryAllowed(category, config.categories)) { return false; }
	return true;
}

/** Extra output sink for passed entries (e.g. the "VibeIDE Log" Output channel), wired by the renderer. */
export type VibeLogSink = (entry: VibeLogEntry) => void;
const sinks = new Set<VibeLogSink>();

/** Render one entry as a single self-contained line — shared by getRecent() and every sink. */
export function formatVibeLogEntry(e: VibeLogEntry): string {
	return `[${e.ts}] [${e.level}] [VibeIDE/${e.category}] ${e.msg}`;
}

// Optional secret-redaction applied to args BEFORE any output (console, ring buffer,
// Output channel, file sink). Set by the renderer once ISecretDetectionService is
// available; without it (e.g. main process) args pass through unredacted as before.
// Centralizing it here closes the gap where firstRunValidation only redacts console.*,
// leaving the ring buffer / clipboard / persistent log file with raw secrets.
export type VibeLogRedactor = (args: readonly unknown[]) => readonly unknown[];
let redactor: VibeLogRedactor | undefined;

// Consecutive-duplicate collapse: identical (level+category+msg) lines in a row are
// suppressed and summarized as "(предыдущее сообщение повторилось ещё ×N)" on the next
// distinct line or after a short idle gap. Kills tight-loop spam (e.g. repeated invalid_params).
let lastKey: string | undefined;
let lastLevel: VibeLogLevel = VibeLogLevel.Info;
let lastCategory = '';
let dupCount = 0;
let dupTimer: ReturnType<typeof setTimeout> | undefined;
const DUP_IDLE_MS = 1500;

function output(level: VibeLogLevel, category: string, args: readonly unknown[], msg: string): void {
	const ts = vibeTraceTs(); // single wall-clock read shared by console head + buffer + sinks
	const head = config.timestamps ? `[${ts}] [VibeIDE/${category}]` : `[VibeIDE/${category}]`;
	switch (level) {
		case VibeLogLevel.Error: console.error(head, ...args); break;
		case VibeLogLevel.Warn: console.warn(head, ...args); break;
		case VibeLogLevel.Info: console.info(head, ...args); break;
		default: console.debug(head, ...args); break; // Debug + Trace share console.debug
	}
	const entry: VibeLogEntry = { atMs: Date.now(), ts, level: LEVEL_NAMES[level], category, msg };
	if (bufferSize > 0) {
		buffer.push(entry);
		if (buffer.length > bufferSize) { buffer.splice(0, buffer.length - bufferSize); }
	}
	if (sinks.size > 0) {
		for (const sink of sinks) {
			try { sink(entry); } catch { /* a sink must never break logging */ }
		}
	}
}

function flushDuplicates(): void {
	if (dupTimer !== undefined) { clearTimeout(dupTimer); dupTimer = undefined; }
	if (dupCount > 0) {
		const n = dupCount;
		dupCount = 0;
		const m = `(предыдущее сообщение повторилось ещё ×${n})`;
		output(lastLevel, lastCategory, [m], m);
		lastKey = undefined; // after a flush, let the next identical line print fresh
	}
}

function emit(level: VibeLogLevel, category: string, args: readonly unknown[]): void {
	knownCats.add(category); // track even when filtered, so pickers can offer it
	if (!passes(level, category)) { return; }
	const safeArgs = redactor ? redactor(args) : args; // redact before any sink/buffer/console
	const msg = safeArgs.map(safeStr).join(' ');
	if (config.dedupe) {
		const key = `${level}\x00${category}\x00${msg}`;
		if (key === lastKey) {
			dupCount++;
			if (dupTimer === undefined) { dupTimer = setTimeout(flushDuplicates, DUP_IDLE_MS); }
			return;
		}
		flushDuplicates(); // emit pending summary for the previous line before switching
		lastKey = key; lastLevel = level; lastCategory = category;
	}
	output(level, category, safeArgs, msg);
}

function applyEnvBaseline(): void {
	let env: Record<string, string | undefined> | undefined;
	try { env = (typeof process !== 'undefined' && process && process.env) ? process.env : undefined; } catch { env = undefined; }
	if (!env) { return; }
	const raw = (env.VIBE_LOG ?? env.VIBE_LOG_LEVEL)?.trim().toLowerCase();
	if (raw) {
		if (['off', '0', 'false', 'none', 'no'].includes(raw)) { config.enabled = false; }
		else if (['1', 'true', 'on', 'yes'].includes(raw)) { config.enabled = true; }
		else if ((LEVEL_NAMES as readonly string[]).includes(raw)) { config.level = vibeLogLevelFromName(raw); config.enabled = raw !== 'off'; }
	}
	const cats = env.VIBE_LOG_CATEGORIES;
	if (cats) {
		const set = cats.split(',').map(c => c.trim()).filter(c => c.length > 0);
		if (set.length > 0) { config.categories = new Set(set); }
	}
}
applyEnvBaseline();

export interface VibeScopedLogger {
	error(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	info(...args: unknown[]): void;
	debug(...args: unknown[]): void;
	trace(...args: unknown[]): void;
}

export interface VibeLogConfigInput {
	enabled?: boolean;
	level?: VibeLogLevel | VibeLogLevelName | string; // raw setting string is resolved by name
	categories?: readonly string[];
	categoryLevels?: { readonly [category: string]: VibeLogLevel | VibeLogLevelName | string };
	timestamps?: boolean;
	bufferSize?: number;
	dedupe?: boolean;
}

export interface VibeLogConfigSnapshot {
	enabled: boolean;
	level: VibeLogLevelName;
	categories: string[] | null;
	categoryLevels: { [category: string]: VibeLogLevelName };
	timestamps: boolean;
	bufferSize: number;
	dedupe: boolean;
}

export const vibeLog = {
	/** Push live config (called by the browser settings bridge). Undefined fields are left unchanged. */
	configure(input: VibeLogConfigInput): void {
		if (typeof input.enabled === 'boolean') { config.enabled = input.enabled; }
		if (input.level !== undefined) {
			config.level = typeof input.level === 'number' ? input.level : vibeLogLevelFromName(input.level);
		}
		if (input.categories !== undefined) {
			const cleaned = input.categories.map(c => c.trim()).filter(c => c.length > 0);
			config.categories = cleaned.length > 0 ? new Set(cleaned) : null;
		}
		if (input.categoryLevels !== undefined) {
			const m = new Map<string, VibeLogLevel>();
			for (const [cat, lvl] of Object.entries(input.categoryLevels)) {
				const c = cat.trim();
				if (c.length === 0) { continue; }
				m.set(c, typeof lvl === 'number' ? lvl : vibeLogLevelFromName(lvl));
			}
			config.categoryLevels = m;
		}
		if (typeof input.timestamps === 'boolean') { config.timestamps = input.timestamps; }
		if (typeof input.dedupe === 'boolean') {
			if (!input.dedupe) { flushDuplicates(); } // emit any pending summary before disabling
			config.dedupe = input.dedupe;
		}
		if (typeof input.bufferSize === 'number' && Number.isFinite(input.bufferSize)) {
			bufferSize = Math.max(0, Math.min(MAX_BUFFER_SIZE, Math.floor(input.bufferSize)));
			if (buffer.length > bufferSize) { buffer.splice(0, buffer.length - bufferSize); }
		}
	},
	/** Install a secret-redaction function applied to args before any output. */
	setRedactor(fn: VibeLogRedactor | undefined): void { redactor = fn; },
	error(category: string, ...args: unknown[]): void { emit(VibeLogLevel.Error, category, args); },
	warn(category: string, ...args: unknown[]): void { emit(VibeLogLevel.Warn, category, args); },
	info(category: string, ...args: unknown[]): void { emit(VibeLogLevel.Info, category, args); },
	debug(category: string, ...args: unknown[]): void { emit(VibeLogLevel.Debug, category, args); },
	trace(category: string, ...args: unknown[]): void { emit(VibeLogLevel.Trace, category, args); },
	/** Pre-bind a category so call sites read `log.warn(...)` instead of repeating it. */
	scoped(category: string): VibeScopedLogger {
		knownCats.add(category);
		return {
			error: (...args: unknown[]) => emit(VibeLogLevel.Error, category, args),
			warn: (...args: unknown[]) => emit(VibeLogLevel.Warn, category, args),
			info: (...args: unknown[]) => emit(VibeLogLevel.Info, category, args),
			debug: (...args: unknown[]) => emit(VibeLogLevel.Debug, category, args),
			trace: (...args: unknown[]) => emit(VibeLogLevel.Trace, category, args),
		};
	},
	/** Register an extra sink for passed entries; returns an unsubscribe function. */
	addSink(sink: VibeLogSink): () => void {
		sinks.add(sink);
		return () => { sinks.delete(sink); };
	},
	/** Formatted snapshot of the in-memory ring buffer (for the "Copy Recent Logs" command). */
	getRecent(limit?: number): string[] {
		const slice = typeof limit === 'number' && limit > 0 ? buffer.slice(-limit) : buffer.slice();
		return slice.map(formatVibeLogEntry);
	},
	/** Raw ring-buffer entries (for sinks that re-emit per level, e.g. the file logger backlog flush). */
	getRecentEntries(limit?: number): VibeLogEntry[] {
		return typeof limit === 'number' && limit > 0 ? buffer.slice(-limit) : buffer.slice();
	},
	/** Sorted list of every category seen this session — feeds the category picker. */
	knownCategories(): string[] {
		return Array.from(knownCats).sort((a, b) => a.localeCompare(b));
	},
	/** Current effective configuration (for status/diagnostic surfaces). */
	getConfig(): VibeLogConfigSnapshot {
		const categoryLevels: { [category: string]: VibeLogLevelName } = {};
		for (const [cat, lvl] of config.categoryLevels) { categoryLevels[cat] = LEVEL_NAMES[lvl]; }
		return {
			enabled: config.enabled,
			level: LEVEL_NAMES[config.level],
			categories: config.categories ? Array.from(config.categories) : null,
			categoryLevels,
			timestamps: config.timestamps,
			bufferSize,
			dedupe: config.dedupe,
		};
	},
};
