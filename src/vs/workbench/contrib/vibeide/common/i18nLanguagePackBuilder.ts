/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VibeIDE language-pack VSIX builder — shapes + sentinel skeleton
 * (roadmap §"Pack VSIX → собственный VSIX `vibeide-language-pack-<locale>`",
 * §"Структура VSIX", §"Канал поставки", §"Gulp-таск
 * extract-vibeide-locale-strings", §"Gulp-таск build-vibeide-language-packs",
 * §"Привязка к релизу: release-windows.ps1").
 *
 * This module is the **pure data-shape skeleton**. The actual gulp tasks +
 * VSIX zip emission live in `build/` and the release pipeline; until they
 * land, callers see a `LanguagePackNotImplementedError` sentinel they can
 * catch and route to "this needs work" UX. The shapes here are stable so
 * the gulp authoring + CLI wrapper can build against them today.
 *
 * What this skeleton DOES provide (pure):
 *   - typed shapes for the VSIX `package.json` `contributes.localizations`
 *     entry that VS Code reads on startup
 *   - typed shape for the per-locale on-disk layout
 *   - typed shape for the GitHub release asset filename + manifest entry
 *   - validators for each shape (decoder + duplicate-id guard)
 *   - sentinel error for the "not yet built" runtime path
 *
 * What this skeleton does NOT provide (waits for runtime):
 *   - actual file emission (gulp pipeline, vsce zip, vsix bundling)
 *   - `npm run build-language-packs` script registration
 *   - hook into `release-windows.ps1` to build pack before main build
 *   - `product.json:builtInExtensions` injection
 */

const SUPPORTED_LOCALE_TAG_PATTERN = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;

export class LanguagePackNotImplementedError extends Error {
	constructor(operation: string) {
		super(
			`VibeIDE language-pack runtime is not yet implemented (operation: ${operation}). ` +
			`Skeleton landed in src/vs/workbench/contrib/vibeide/common/i18nLanguagePackBuilder.ts; ` +
			`gulp tasks (extract-vibeide-locale-strings + build-vibeide-language-packs) and ` +
			`release-windows.ps1 hook are the next runtime steps. See roadmap §"Pack VSIX".`,
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

/**
 * Decode the `contributes.localizations[i]` shape from a VSIX manifest.
 * Pure — caller has already JSON.parse'd the manifest. Refuses unknown
 * locale-tag formats so a typo doesn't ship.
 */
export function decodeLanguagePackContribution(raw: unknown): DecodeResult<LanguagePackContribution> {
	if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not-an-object' };
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
		if (!t || typeof t !== 'object') return { ok: false, reason: `translations[${i}]:not-object` };
		const e = t as Record<string, unknown>;
		if (typeof e.id !== 'string' || e.id.length === 0) return { ok: false, reason: `translations[${i}]:id-missing` };
		if (typeof e.path !== 'string' || e.path.length === 0) return { ok: false, reason: `translations[${i}]:path-missing` };
		if (seenIds.has(e.id)) return { ok: false, reason: `translations[${i}]:duplicate-id:${e.id}` };
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
	/** Mirrors `src/vs/workbench/contrib/vibeide/` keyed by relative file. */
	readonly mainBundles: Readonly<Record<string, ReadonlyMap<string, string>>>;
	/** Per-extension `package.i18n.json` keyed by extension folder name. */
	readonly extensionPackageBundles: Readonly<Record<string, ReadonlyMap<string, string>>>;
}

/**
 * Build the canonical layout for a locale. Pure — no IO. Caller has
 * already loaded the per-file translations into Maps.
 */
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

/**
 * Build the GitHub release asset filename for a language pack VSIX:
 *   `vibeide-language-pack-<locale>-<vibeVersion>.vsix`
 *
 * Pure — refuses malformed inputs early so a release build cannot ship a
 * file with an unparseable tag.
 */
export function buildLanguagePackAssetName(localeTag: string, vibeVersion: string): string {
	if (typeof localeTag !== 'string' || !SUPPORTED_LOCALE_TAG_PATTERN.test(localeTag)) {
		throw new LanguagePackNotImplementedError(`buildLanguagePackAssetName(invalid-locale=${String(localeTag)})`);
	}
	if (typeof vibeVersion !== 'string' || vibeVersion.length === 0) {
		throw new LanguagePackNotImplementedError(`buildLanguagePackAssetName(missing-version)`);
	}
	const trimmedTag = localeTag.trim().toLowerCase();
	const trimmedVer = vibeVersion.trim();
	return `vibeide-language-pack-${trimmedTag}-${trimmedVer}.vsix`;
}

// -----------------------------------------------------------------------------
// Sentinel runtime hooks (roadmap lines 495 + 496 + 498)
// -----------------------------------------------------------------------------

/**
 * Stub for the gulp task `extract-vibeide-locale-strings` (roadmap line 495).
 * Throws the sentinel — caller (gulp authoring side) replaces this with the
 * real extraction wired to `build/lib/i18n.ts:getL10nXlf`.
 */
export function extractVibeideLocaleStrings(_input: { srcRoot: string; outFile: string }): never {
	throw new LanguagePackNotImplementedError('extractVibeideLocaleStrings');
}

/**
 * Stub for the gulp task `build-vibeide-language-packs` (roadmap line 496).
 * Throws the sentinel — caller replaces with the actual VSIX zip emission
 * (vsce or equivalent).
 */
export function buildVibeideLanguagePacks(_input: { metadataPath: string; localesDir: string; outDir: string }): never {
	throw new LanguagePackNotImplementedError('buildVibeideLanguagePacks');
}

/**
 * Stub for the release-pipeline hook (roadmap line 498).
 * Throws the sentinel — caller replaces with the real `release-windows.ps1`
 * pre-build step that emits the language pack(s) before the main build.
 */
export function buildLanguagePackForRelease(_input: { vibeVersion: string; locales: ReadonlyArray<string> }): never {
	throw new LanguagePackNotImplementedError('buildLanguagePackForRelease');
}
