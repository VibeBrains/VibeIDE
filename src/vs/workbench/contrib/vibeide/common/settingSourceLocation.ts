/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Settings UI — Ctrl+Click → source-location metadata builder
 * (roadmap §"i18n improvements — Inline-просмотр исходника: в Settings UI
 * на VibeIDE-настройке `Ctrl+Click` по описанию → открывает соответствующий
 * `localize()` в редакторе (через `IConfigurationRegistry` метаданные)").
 *
 * Pure helpers — `vscode`-free. The runtime contribution stamps each
 * VibeIDE setting with a `_sourceLocation` field (file path + line number
 * + the `localize()` key) at registration time; this module decodes that
 * stamp and validates the format so the Ctrl+Click handler can open the
 * editor at the exact line.
 */

const KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_./-]*$/;

export interface SourceLocation {
	readonly filePath: string;
	readonly lineNumber: number;
	readonly localizeKey: string;
}

export interface SettingMetadataStamp {
	readonly settingKey: string;
	readonly source: SourceLocation;
}

export type DecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

const SETTING_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*$/;

/**
 * Validate a source-location stamp. Pure.
 * Refuses non-positive line numbers, empty paths, malformed localize keys.
 */
export function decodeSourceLocation(raw: unknown): DecodeResult<SourceLocation> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const o = raw as Record<string, unknown>;
	if (typeof o.filePath !== 'string' || o.filePath.trim().length === 0) {
		return { ok: false, reason: 'filePath-empty' };
	}
	if (typeof o.lineNumber !== 'number' || !Number.isInteger(o.lineNumber) || o.lineNumber < 1) {
		return { ok: false, reason: 'lineNumber-invalid' };
	}
	if (typeof o.localizeKey !== 'string' || !KEY_PATTERN.test(o.localizeKey)) {
		return { ok: false, reason: 'localizeKey-malformed' };
	}
	return {
		ok: true,
		value: {
			filePath: o.filePath.trim(),
			lineNumber: o.lineNumber,
			localizeKey: o.localizeKey,
		},
	};
}

/**
 * Build a stamp from `IConfigurationRegistry`-style registration call.
 * Pure — caller passes the path it captured via `Error.stack` / `import.meta`
 * at registration time.
 */
export function buildSettingMetadataStamp(input: {
	readonly settingKey: string;
	readonly filePath: string;
	readonly lineNumber: number;
	readonly localizeKey: string;
}): DecodeResult<SettingMetadataStamp> {
	if (typeof input.settingKey !== 'string' || !SETTING_KEY_PATTERN.test(input.settingKey)) {
		return { ok: false, reason: 'settingKey-malformed' };
	}
	const src = decodeSourceLocation({
		filePath: input.filePath,
		lineNumber: input.lineNumber,
		localizeKey: input.localizeKey,
	});
	if (!src.ok) { return { ok: false, reason: src.reason }; }
	return {
		ok: true,
		value: { settingKey: input.settingKey, source: src.value },
	};
}

/**
 * Build a "go-to" target — typically a `vscode.Uri` would be made by the
 * caller; helper produces the workspace-relative path + range data.
 *
 * Returns the cleaned absolute / workspace-relative path plus a 0-based
 * range that VS Code's editor APIs consume directly.
 */
export interface GoToTarget {
	readonly filePath: string;
	readonly startLine0: number;
	readonly startCol0: number;
	readonly endLine0: number;
	readonly endCol0: number;
}

export function buildGoToTarget(loc: SourceLocation): GoToTarget {
	const startLine0 = Math.max(0, loc.lineNumber - 1);
	const keyEndCol = approximateKeyEndCol(loc.localizeKey);
	return {
		filePath: loc.filePath,
		startLine0,
		startCol0: 0,
		endLine0: startLine0,
		endCol0: keyEndCol,
	};
}

function approximateKeyEndCol(key: string): number {
	// Rough heuristic — `localize('<key>', ...)` is ~`localize(` + len(key) + 1
	// for the opening quote. Caller can refine by reading the actual line.
	return Math.min(200, 'localize(\''.length + key.length + 1);
}

// -----------------------------------------------------------------------------
// Stamp registry — bulk operations
// -----------------------------------------------------------------------------

/**
 * Index a list of stamps by setting key for O(1) lookup. Pure.
 * Refuses duplicate setting keys (one location per setting).
 */
export function indexStampsBySettingKey(
	stamps: ReadonlyArray<SettingMetadataStamp>,
): DecodeResult<ReadonlyMap<string, SettingMetadataStamp>> {
	const out = new Map<string, SettingMetadataStamp>();
	for (const s of stamps) {
		if (out.has(s.settingKey)) {
			return { ok: false, reason: `duplicate-setting:${s.settingKey}` };
		}
		out.set(s.settingKey, s);
	}
	return { ok: true, value: out };
}

/**
 * Resolve the source location for a given setting key. Pure.
 * Returns `null` when the key is not stamped — the Ctrl+Click handler
 * surfaces "no source mapping for this setting".
 */
export function resolveSettingSource(
	settingKey: string,
	index: ReadonlyMap<string, SettingMetadataStamp>,
): SourceLocation | null {
	const stamp = index.get(settingKey);
	return stamp === undefined ? null : stamp.source;
}

/**
 * Return setting keys that share the same source location — useful for
 * the "all settings declared at this line" navigation shortcut.
 */
export function findSiblingSettings(
	settingKey: string,
	index: ReadonlyMap<string, SettingMetadataStamp>,
): readonly string[] {
	const stamp = index.get(settingKey);
	if (stamp === undefined) { return []; }
	const out: string[] = [];
	for (const [k, s] of index) {
		if (k === settingKey) { continue; }
		if (s.source.filePath === stamp.source.filePath && s.source.lineNumber === stamp.source.lineNumber) {
			out.push(k);
		}
	}
	out.sort();
	return out;
}
