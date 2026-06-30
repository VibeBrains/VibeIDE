/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Data types for the shell-hardening anti-misuse layer.
 *
 * Shell hardening detects when an LLM-issued `run_command` duplicates a dedicated
 * built-in tool (read_file / grep / ls_dir / glob / edit_file). The default
 * ruleset is defined in `shellHardeningDefaults.ts` and is bundled with the IDE.
 * Workspaces can extend it via `.vibe/shell-hardening.json` — see
 * `shellHardeningService.ts` for the loader.
 *
 * Rules are expressed as DATA, not inline regex code, so the same shape can be
 * authored in the bundled defaults and in workspace JSON without two code paths.
 */

export type ShellMisuseKind =
	| 'read_file'
	| 'list_dir'
	| 'search_pathnames'
	| 'search_content'
	| 'edit_file'
	| 'write_file'
	| 'tree';

export interface ShellMisuse {
	readonly kind: ShellMisuseKind;
	readonly suggestedTool: string;
	readonly hint: string;
}

/**
 * A single shell-hardening rule. All regex fields are case-insensitive strings
 * (compiled lazily by the detector). `bareName` is anchored to the head of the
 * command — only the first whitespace-delimited token is matched.
 *
 * Optional `requires` predicates ALL must hold for the rule to fire. Optional
 * `exempts` regex list, if ANY matches the tail-after-bareName, makes the rule
 * skip even when `requires` would have matched (used e.g. to allow
 * `dir /s /b <specific-file.ext>` while still blocking `dir /s <directory>`).
 */
export interface ShellHardeningRule {
	/** Stable identifier (for telemetry, logs, override-by-id in workspace JSON). */
	readonly id: string;

	/** Case-insensitive regex source matched against the bare command name (no path/extension). */
	readonly bareName: string;

	readonly requires?: {
		/** Regex source. Rule only fires if tail-after-bareName matches. */
		readonly tailMatches?: string;
		/** If true, rule only fires when the command does NOT contain a pipe `|`. */
		readonly notPiped?: boolean;
	};

	/** Regex sources. If ANY matches the tail-after-bareName, the rule skips. */
	readonly exempts?: readonly string[];

	readonly kind: ShellMisuseKind;
	readonly suggestedTool: string;

	/**
	 * User-facing hint string. May contain `{bareName}` placeholder which the
	 * detector substitutes with the matched bare command name.
	 */
	readonly hint: string;
}

/**
 * Workspace-level overrides loaded from `.vibe/shell-hardening.json`.
 */
export interface ShellHardeningConfig {
	readonly vibeVersion?: string;

	/**
	 * Regex sources. If a command matches ANY of these, all default rules are
	 * bypassed (the command is allowed). Use to whitelist patterns specific to
	 * this workspace (e.g. `^dir\s+/s\s+/b\s+` for file-existence idioms beyond
	 * the default `.<ext>` heuristic).
	 */
	readonly allowedPatterns?: readonly string[];

	/**
	 * If set, default rules with these ids are disabled. Use to surgically opt
	 * out of a specific shipped rule (e.g. `["search_content"]` to allow `grep`
	 * for a workspace that prefers shell ripgrep over the built-in tool).
	 */
	readonly disableDefaultRules?: readonly string[];

	/** Additional workspace-specific rules merged after defaults. */
	readonly extraRules?: readonly ShellHardeningRule[];
}

export const SHELL_HARDENING_CONFIG_VERSION = '1';
