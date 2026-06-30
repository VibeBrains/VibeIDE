/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Open VSX manifest validator (roadmap §1124) — pure helper.
 *
 * Open VSX (https://open-vsx.org) is the open-source extension marketplace
 * compatible with the VS Code extension protocol. Publishing there requires
 * the extension `package.json` to satisfy a stricter set of rules than the
 * MS Marketplace — empty descriptions, missing repository fields, and
 * undeclared license cause publish failures.
 *
 * This helper validates the manifest **before** `ovsx publish` runs so the
 * CLI fails fast with a clear list of issues instead of one Open VSX 4xx.
 *
 * Pure: caller reads package.json into a string, parses, hands the object in.
 * vscode-free.
 */

export interface ExtensionManifest {
	readonly name?: unknown;
	readonly displayName?: unknown;
	readonly description?: unknown;
	readonly version?: unknown;
	readonly publisher?: unknown;
	readonly license?: unknown;
	readonly engines?: { readonly vscode?: unknown } & Record<string, unknown>;
	readonly repository?: unknown;
	readonly homepage?: unknown;
	readonly bugs?: unknown;
	readonly keywords?: unknown;
	readonly categories?: unknown;
	readonly icon?: unknown;
	readonly main?: unknown;
}

export interface ValidationIssue {
	readonly field: string;
	readonly severity: 'error' | 'warning';
	readonly message: string;
}

export type ValidationResult =
	| { readonly ok: true; readonly issues: ReadonlyArray<ValidationIssue> /* warnings only */ }
	| { readonly ok: false; readonly issues: ReadonlyArray<ValidationIssue> };

const MIN_DESCRIPTION_LENGTH = 20;
const ALLOWED_LICENSE_PATTERN = /^(MIT|Apache-2\.0|BSD-3-Clause|BSD-2-Clause|GPL-3\.0|GPL-2\.0|MPL-2\.0|ISC|UNLICENSED|SEE LICENSE IN .+)$/i;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
// Open VSX uses standard VS Code categories. "VibeIDE" is not standard yet —
// flag as warning until the Open VSX namespace registers a custom category.
const STANDARD_CATEGORIES: ReadonlyArray<string> = [
	'AI',
	'Azure',
	'Chat',
	'Data Science',
	'Debuggers',
	'Education',
	'Extension Packs',
	'Formatters',
	'Keymaps',
	'Language Packs',
	'Linters',
	'Machine Learning',
	'Notebooks',
	'Programming Languages',
	'SCM Providers',
	'Snippets',
	'Testing',
	'Themes',
	'Visualization',
	'Other',
];

export function validateOpenVsxManifest(manifest: ExtensionManifest): ValidationResult {
	const issues: ValidationIssue[] = [];

	requireNonEmptyString(manifest.name, 'name', issues);
	requireNonEmptyString(manifest.displayName, 'displayName', issues);
	requireNonEmptyString(manifest.publisher, 'publisher', issues);

	if (typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
		issues.push({ field: 'description', severity: 'error', message: 'description is required for marketplace listing.' });
	} else if (manifest.description.trim().length < MIN_DESCRIPTION_LENGTH) {
		issues.push({ field: 'description', severity: 'warning', message: `description shorter than ${MIN_DESCRIPTION_LENGTH} chars hurts marketplace search ranking.` });
	}

	if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) {
		issues.push({ field: 'version', severity: 'error', message: 'version must be SemVer (e.g. 0.1.0).' });
	}

	if (typeof manifest.license !== 'string' || !ALLOWED_LICENSE_PATTERN.test(manifest.license)) {
		issues.push({ field: 'license', severity: 'error', message: `license must be a recognized SPDX identifier (got "${String(manifest.license)}").` });
	}

	const engineVscode = manifest.engines && typeof manifest.engines === 'object' ? (manifest.engines as { vscode?: unknown }).vscode : undefined;
	if (typeof engineVscode !== 'string' || !/^[\^~>=<]/.test(engineVscode)) {
		issues.push({ field: 'engines.vscode', severity: 'error', message: 'engines.vscode is required (e.g. "^1.118.0").' });
	}

	if (!isUrlOrRepoSpec(manifest.repository)) {
		issues.push({ field: 'repository', severity: 'error', message: 'repository must be a URL or { type, url } — Open VSX rejects extensions without it.' });
	}

	if (manifest.bugs !== undefined && !isUrlOrRepoSpec(manifest.bugs)) {
		issues.push({ field: 'bugs', severity: 'warning', message: 'bugs should be a URL or { url } pointing to the issue tracker.' });
	}

	if (manifest.homepage !== undefined && (typeof manifest.homepage !== 'string' || !/^https?:\/\//.test(manifest.homepage))) {
		issues.push({ field: 'homepage', severity: 'warning', message: 'homepage should be an https URL.' });
	}

	if (!Array.isArray(manifest.categories) || manifest.categories.length === 0) {
		issues.push({ field: 'categories', severity: 'warning', message: 'no categories declared; pick from the Open VSX standard set.' });
	} else {
		const arr = manifest.categories as ReadonlyArray<unknown>;
		for (let i = 0; i < arr.length; i++) {
			if (typeof arr[i] !== 'string') {
				issues.push({ field: `categories[${i}]`, severity: 'error', message: 'category entries must be strings.' });
				continue;
			}
			if (!STANDARD_CATEGORIES.includes(arr[i] as string)) {
				issues.push({ field: `categories[${i}]`, severity: 'warning', message: `"${arr[i]}" is not a standard Open VSX category; will be filed under "Other".` });
			}
		}
	}

	if (manifest.keywords !== undefined && !Array.isArray(manifest.keywords)) {
		issues.push({ field: 'keywords', severity: 'warning', message: 'keywords should be an array of strings.' });
	}

	const errors = issues.filter(i => i.severity === 'error');
	return errors.length > 0
		? { ok: false, issues }
		: { ok: true, issues };
}

function requireNonEmptyString(value: unknown, field: string, issues: ValidationIssue[]): void {
	if (typeof value !== 'string' || value.trim().length === 0) {
		issues.push({ field, severity: 'error', message: `${field} is required.` });
	}
}

function isUrlOrRepoSpec(value: unknown): boolean {
	if (typeof value === 'string') {
		return /^(https?:\/\/|git\+https?:\/\/|git@)/.test(value);
	}
	if (value !== null && typeof value === 'object') {
		const v = value as { url?: unknown };
		return typeof v.url === 'string' && /^(https?:\/\/|git\+https?:\/\/|git@)/.test(v.url);
	}
	return false;
}

/** Render the validation result as a human-readable report. */
export function describeValidationResult(result: ValidationResult): string {
	const lines: string[] = [];
	const errors = result.issues.filter(i => i.severity === 'error');
	const warnings = result.issues.filter(i => i.severity === 'warning');
	lines.push(`Open VSX manifest: ${result.ok ? 'OK' : 'FAILED'} (${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'})`);
	for (const issue of result.issues) {
		const tag = issue.severity === 'error' ? 'ERROR' : 'WARN ';
		lines.push(`  [${tag}] ${issue.field}: ${issue.message}`);
	}
	return lines.join('\n');
}
