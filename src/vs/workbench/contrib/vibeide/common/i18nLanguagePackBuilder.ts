/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeIDE language-pack VSIX builder — pure shapes + IO orchestrator.
 *
 * Pure module: no direct fs/node imports. The orchestrator helpers
 * (`writeLanguagePackLayout`, `injectLanguagePackIntoProductJson`) accept
 * injected IO callbacks so the gulp pipeline / release-windows.ps1
 * wrapper does the actual writes while this module stays unit-testable.
 *
 * Runtime callers:
 *   - build/gulpfile.vibeide-i18n.ts                — gulp tasks (extract +
 *                                                     build VSIX zip).
 *   - bin/vibe-language-pack-build.mjs              — Node CLI for
 *                                                     `npm run build-language-packs`.
 *   - scripts/release-windows.ps1 (steps 0/0b)      — pre-build hook.
 */

const SUPPORTED_LOCALE_TAG_PATTERN = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export class LanguagePackNotImplementedError extends Error {
	constructor(operation: string) {
		super(
			`VibeIDE language-pack input rejected (operation: ${operation}). ` +
			`See src/vs/workbench/contrib/vibeide/common/i18nLanguagePackBuilder.ts ` +
			`and roadmap §"Pack VSIX".`,
		);
		this.name = 'LanguagePackNotImplementedError';
	}
}

// -----------------------------------------------------------------------------
// VSIX `package.json:contributes.localizations` entry (roadmap line 487)
// -----------------------------------------------------------------------------

export interface LanguagePackContribution {
	readonly id: string;
	readonly localizedLanguageName: string;
	readonly translations: ReadonlyArray<{ readonly id: string; readonly path: string }>;
}

export type DecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

export function decodeLanguagePackContribution(raw: unknown): DecodeResult<LanguagePackContribution> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== 'string' || !SUPPORTED_LOCALE_TAG_PATTERN.test(o.id)) {
		return { ok: false, reason: 'id-invalid' };
	}
	if (typeof o.localizedLanguageName !== 'string' || o.localizedLanguageName.length === 0) {
		return { ok: false, reason: 'localizedLanguageName-missing' };
	}
	if (!Array.isArray(o.translations) || o.translations.length === 0) {
		return { ok: false, reason: 'translations-empty' };
	}
	const translations: { id: string; path: string }[] = [];
	const seenIds = new Set<string>();
	for (let i = 0; i < o.translations.length; i++) {
		const t = o.translations[i];
		if (!t || typeof t !== 'object') { return { ok: false, reason: `translations[${i}]:not-object` }; }
		const e = t as Record<string, unknown>;
		if (typeof e.id !== 'string' || e.id.length === 0) { return { ok: false, reason: `translations[${i}]:id-missing` }; }
		if (typeof e.path !== 'string' || e.path.length === 0) { return { ok: false, reason: `translations[${i}]:path-missing` }; }
		if (seenIds.has(e.id)) { return { ok: false, reason: `translations[${i}]:duplicate-id:${e.id}` }; }
		seenIds.add(e.id);
		translations.push({ id: e.id, path: e.path });
	}
	return {
		ok: true,
		value: { id: o.id.toLowerCase(), localizedLanguageName: o.localizedLanguageName, translations },
	};
}

// -----------------------------------------------------------------------------
// Per-locale on-disk layout (roadmap line 488)
// -----------------------------------------------------------------------------

export interface LanguagePackLayout {
	readonly localeTag: string;
	readonly mainBundles: Readonly<Record<string, ReadonlyMap<string, string>>>;
	readonly extensionPackageBundles: Readonly<Record<string, ReadonlyMap<string, string>>>;
}

export function buildLanguagePackLayout(input: {
	readonly localeTag: string;
	readonly mainBundleEntries: ReadonlyArray<readonly [string, ReadonlyMap<string, string>]>;
	readonly extensionPackageEntries: ReadonlyArray<readonly [string, ReadonlyMap<string, string>]>;
}): LanguagePackLayout {
	const mainBundles: Record<string, ReadonlyMap<string, string>> = {};
	for (const [path, m] of input.mainBundleEntries) {
		mainBundles[path] = m;
	}
	const extensionPackageBundles: Record<string, ReadonlyMap<string, string>> = {};
	for (const [extName, m] of input.extensionPackageEntries) {
		extensionPackageBundles[extName] = m;
	}
	return {
		localeTag: input.localeTag.trim().toLowerCase(),
		mainBundles,
		extensionPackageBundles,
	};
}

// -----------------------------------------------------------------------------
// GitHub release asset shape (roadmap line 490)
// -----------------------------------------------------------------------------

export function buildLanguagePackAssetName(localeTag: string, vibeVersion: string): string {
	if (typeof localeTag !== 'string') {
		throw new LanguagePackNotImplementedError(`buildLanguagePackAssetName(invalid-locale=${String(localeTag)})`);
	}
	// Trim before validating so a padded-but-valid locale ("  RU-BY  ") is accepted
	// and normalized, mirroring buildLanguagePackLayout.
	const trimmedTag = localeTag.trim().toLowerCase();
	if (!SUPPORTED_LOCALE_TAG_PATTERN.test(trimmedTag)) {
		throw new LanguagePackNotImplementedError(`buildLanguagePackAssetName(invalid-locale=${localeTag})`);
	}
	if (typeof vibeVersion !== 'string' || vibeVersion.trim().length === 0) {
		throw new LanguagePackNotImplementedError(`buildLanguagePackAssetName(missing-version)`);
	}
	const trimmedVer = vibeVersion.trim();
	return `vibeide-language-pack-${trimmedTag}-${trimmedVer}.vsix`;
}

// -----------------------------------------------------------------------------
// File-write orchestrator (roadmap line 488)
// -----------------------------------------------------------------------------

export interface LanguagePackWriteIO {
	readonly mkdirRecursive: (dirAbsPath: string) => void;
	readonly writeFileUtf8: (fileAbsPath: string, content: string) => void;
	readonly joinPath: (...segments: string[]) => string;
}

export interface LanguagePackWriteResult {
	readonly localeTag: string;
	readonly rootDir: string;
	readonly writtenFiles: readonly string[];
}

/**
 * Materialise a `LanguagePackLayout` to disk under `outDir/<localeTag>/`.
 * Pure logic — fs calls go through the injected `io` so the helper stays
 * unit-testable.
 *
 * Emits files:
 *   <outDir>/<locale>/translations/main/<mainBundlePath>
 *   <outDir>/<locale>/translations/extensions/<extName>/package.i18n.json
 *
 * Returns the absolute paths of every file written (stable sort) so the
 * caller can hand them to the VSIX packer or verify the manifest.
 */
export function writeLanguagePackLayout(
	layout: LanguagePackLayout,
	outDir: string,
	io: LanguagePackWriteIO,
): LanguagePackWriteResult {
	if (!layout || typeof layout.localeTag !== 'string' || !SUPPORTED_LOCALE_TAG_PATTERN.test(layout.localeTag)) {
		throw new LanguagePackNotImplementedError(`writeLanguagePackLayout(invalid-localeTag)`);
	}
	if (typeof outDir !== 'string' || outDir.length === 0) {
		throw new LanguagePackNotImplementedError(`writeLanguagePackLayout(empty-outDir)`);
	}

	const rootDir = io.joinPath(outDir, layout.localeTag);
	const translationsDir = io.joinPath(rootDir, 'translations');
	io.mkdirRecursive(rootDir);
	io.mkdirRecursive(translationsDir);

	const written: string[] = [];

	const mainDir = io.joinPath(translationsDir, 'main');
	io.mkdirRecursive(mainDir);
	const mainPaths = Object.keys(layout.mainBundles).sort();
	for (const relPath of mainPaths) {
		const map = layout.mainBundles[relPath];
		const safeRel = relPath.replace(/^[/\\]+/, '').replace(/[\\]/g, '/');
		const absPath = io.joinPath(mainDir, ...safeRel.split('/'));
		const dir = absPath.slice(0, absPath.length - safeRel.split('/').slice(-1)[0].length);
		if (dir.length > 0) { io.mkdirRecursive(dir); }
		io.writeFileUtf8(absPath, stringifySortedMap(map));
		written.push(absPath);
	}

	const extDir = io.joinPath(translationsDir, 'extensions');
	io.mkdirRecursive(extDir);
	const extNames = Object.keys(layout.extensionPackageBundles).sort();
	for (const extName of extNames) {
		const map = layout.extensionPackageBundles[extName];
		const extFolder = io.joinPath(extDir, extName);
		io.mkdirRecursive(extFolder);
		const absPath = io.joinPath(extFolder, 'package.i18n.json');
		io.writeFileUtf8(absPath, stringifySortedMap(map));
		written.push(absPath);
	}

	return {
		localeTag: layout.localeTag,
		rootDir,
		writtenFiles: written,
	};
}

function stringifySortedMap(map: ReadonlyMap<string, string>): string {
	const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
	const obj: Record<string, string> = {};
	for (const [k, v] of sorted) { obj[k] = v; }
	return JSON.stringify(obj, null, '\t') + '\n';
}

// -----------------------------------------------------------------------------
// product.json:builtInExtensions injection (roadmap line 490)
// -----------------------------------------------------------------------------

export interface BuiltInExtensionEntry {
	readonly name: string;
	readonly version: string;
	readonly repo: string;
	readonly metadata?: Record<string, unknown>;
}

/**
 * Inject a language-pack entry into `product.json:builtInExtensions`.
 * Pure mutation on a deep-clone of the caller's product object — caller
 * writes the result back to disk.
 *
 * - Duplicate `name` entries are de-duplicated by `name`; the new entry
 *   replaces the older version.
 * - Sorted by `name` so the file diff stays minimal.
 * - Refuses non-SemVer versions to keep the field machine-parseable.
 */
export function injectLanguagePackIntoProductJson(
	productJson: Record<string, unknown>,
	entry: { readonly localeTag: string; readonly vibeVersion: string; readonly repo: string },
): Record<string, unknown> {
	if (!productJson || typeof productJson !== 'object') {
		throw new LanguagePackNotImplementedError('injectLanguagePackIntoProductJson(invalid-product)');
	}
	if (!SUPPORTED_LOCALE_TAG_PATTERN.test(entry.localeTag)) {
		throw new LanguagePackNotImplementedError(`injectLanguagePackIntoProductJson(invalid-locale=${entry.localeTag})`);
	}
	if (!SEMVER_PATTERN.test(entry.vibeVersion)) {
		throw new LanguagePackNotImplementedError(`injectLanguagePackIntoProductJson(invalid-version=${entry.vibeVersion})`);
	}
	if (typeof entry.repo !== 'string' || entry.repo.length === 0) {
		throw new LanguagePackNotImplementedError('injectLanguagePackIntoProductJson(empty-repo)');
	}

	const clone: Record<string, unknown> = JSON.parse(JSON.stringify(productJson));
	const existing = Array.isArray(clone.builtInExtensions) ? clone.builtInExtensions as BuiltInExtensionEntry[] : [];
	const localeTag = entry.localeTag.toLowerCase();
	const name = `vibeide-language-pack-${localeTag}`;

	const merged: BuiltInExtensionEntry[] = existing.filter(e => e && typeof e === 'object' && e.name !== name);
	merged.push({
		name,
		version: entry.vibeVersion,
		repo: entry.repo,
		metadata: { id: name, publisherDisplayName: 'VibeIDE Team' },
	});
	merged.sort((a, b) => a.name.localeCompare(b.name));

	clone.builtInExtensions = merged;
	return clone;
}

// -----------------------------------------------------------------------------
// Release-pipeline contract (roadmap line 498)
// -----------------------------------------------------------------------------

export interface LanguagePackReleasePlan {
	readonly vibeVersion: string;
	readonly assets: ReadonlyArray<{ readonly localeTag: string; readonly assetName: string }>;
}

/**
 * Compute the per-locale VSIX assets the release pipeline must upload.
 * Pure — `release-windows.ps1` calls this through the gulp pipeline by
 * way of `bin/vibe-language-pack-build.mjs` and uses the returned
 * `assetName` list to add files to the `gh release create` argv.
 */
export function planLanguagePackRelease(input: {
	readonly vibeVersion: string;
	readonly locales: ReadonlyArray<string>;
}): LanguagePackReleasePlan {
	if (!SEMVER_PATTERN.test(input.vibeVersion)) {
		throw new LanguagePackNotImplementedError(`planLanguagePackRelease(invalid-version=${input.vibeVersion})`);
	}
	if (!Array.isArray(input.locales)) {
		throw new LanguagePackNotImplementedError('planLanguagePackRelease(locales-not-array)');
	}
	const seen = new Set<string>();
	const assets: { localeTag: string; assetName: string }[] = [];
	for (const raw of input.locales) {
		if (typeof raw !== 'string' || !SUPPORTED_LOCALE_TAG_PATTERN.test(raw)) {
			throw new LanguagePackNotImplementedError(`planLanguagePackRelease(invalid-locale=${String(raw)})`);
		}
		const tag = raw.toLowerCase();
		if (seen.has(tag)) { continue; }
		seen.add(tag);
		assets.push({ localeTag: tag, assetName: buildLanguagePackAssetName(tag, input.vibeVersion) });
	}
	assets.sort((a, b) => a.localeTag.localeCompare(b.localeTag));
	return { vibeVersion: input.vibeVersion, assets };
}
