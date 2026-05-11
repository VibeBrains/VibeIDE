#!/usr/bin/env node
/**
 * VibeIDE language-pack VSIX build orchestrator (skeleton).
 *
 * Closes roadmap §521 ("vibeide-language-pack-ru.vsix собирается воспроизводимо
 * из npm run build-language-packs") as an executable skeleton aligned with the
 * pure shape skeleton in
 *   src/vs/workbench/contrib/vibeide/common/i18nLanguagePackBuilder.ts
 *
 * Usage:
 *   node bin/vibe-language-pack-build.mjs --locale ru
 *   node bin/vibe-language-pack-build.mjs --locale ru --staging-only
 *
 * Pipeline (per skeleton contract):
 *   1. Validate locale tag (lowercase, 2..3 chars, optional region).
 *   2. Resolve translations — placeholder paths for now (to be wired to
 *      build/lib/i18n.ts gulp output once `extract-vibeide-locale-strings`
 *      lands).
 *   3. Compose `contributes.localizations` entry shape and validate via
 *      `decodeLanguagePackContribution` (when wired to the bundle).
 *   4. Stage `.build/language-packs/<locale>/` with package.json + nls bundles.
 *   5. (Sentinel) The actual VSIX zip step requires @vscode/vsce or archiver
 *      — that step is intentionally fail-loud until the install is approved.
 *
 * The script is fail-loud-on-the-zip-step by design: it does NOT silently
 * produce an incomplete VSIX. Adoption path:
 *   - npm install @vscode/vsce (or archiver)
 *   - replace the throw at the bottom of buildVsix() with the real packer
 *   - wire to release-windows.ps1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SUPPORTED_LOCALE_TAG_PATTERN = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;

class LanguagePackBuildError extends Error {
	constructor(stage, detail) {
		super(`[vibe-language-pack-build] ${stage}: ${detail}`);
		this.name = 'LanguagePackBuildError';
	}
}

function parseArgs(argv) {
	const args = { locale: undefined, stagingOnly: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--locale' && argv[i + 1]) { args.locale = argv[++i]; continue; }
		if (a === '--staging-only') { args.stagingOnly = true; continue; }
		if (a === '--help' || a === '-h') { args.help = true; continue; }
	}
	return args;
}

function printHelp() {
	console.log(`VibeIDE language-pack build (skeleton)

Usage:
  node bin/vibe-language-pack-build.mjs --locale <tag> [--staging-only]

Options:
  --locale <tag>     Locale tag (lowercase, e.g. ru, en, pt-br).
  --staging-only     Stop after composing .build/language-packs/<locale>/
                     (skip the VSIX zip step which is currently fail-loud).
  --help             Show this help.

Status: skeleton. Zip step requires @vscode/vsce or archiver install. See the
file header for the adoption path.`);
}

function validateLocale(locale) {
	if (!locale) {
		throw new LanguagePackBuildError('locale', 'missing --locale');
	}
	if (!SUPPORTED_LOCALE_TAG_PATTERN.test(locale)) {
		throw new LanguagePackBuildError('locale', `invalid tag "${locale}" — expected /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i`);
	}
	return locale.toLowerCase();
}

function resolveTranslationSources(locale) {
	// TODO: read from build/lib/i18n.ts gulp output when extract-vibeide-locale-strings lands.
	const messagesPath = path.join(ROOT, 'out', 'nls.messages.json');
	if (!fs.existsSync(messagesPath)) {
		throw new LanguagePackBuildError('translations', `out/nls.messages.json missing — run 'npm run nls-extract' first`);
	}
	return [{ id: 'vscode', path: messagesPath }];
}

function composeContribution(locale, translations) {
	return {
		id: locale,
		localizedLanguageName: localizedLanguageName(locale),
		translations: translations.map(t => ({ id: t.id, path: `./${t.id}/main.i18n.json` })),
	};
}

function localizedLanguageName(locale) {
	const map = {
		ru: 'Русский',
		en: 'English',
		'pt-br': 'Português (Brasil)',
	};
	return map[locale] ?? locale;
}

function stageDirectory(locale, contribution, translations) {
	const stageDir = path.join(ROOT, '.build', 'language-packs', locale);
	fs.rmSync(stageDir, { recursive: true, force: true });
	fs.mkdirSync(stageDir, { recursive: true });

	// package.json shape mirrors VS Code's localization extension manifest.
	const pkg = {
		name: `vibeide-language-pack-${locale}`,
		displayName: `VibeIDE Language Pack — ${contribution.localizedLanguageName}`,
		version: readVibeVersion(),
		publisher: 'vibeide',
		license: 'MIT',
		engines: { vscode: '*' },
		categories: ['Language Packs'],
		contributes: { localizations: [contribution] },
	};
	fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

	for (const t of translations) {
		const dest = path.join(stageDir, t.id);
		fs.mkdirSync(dest, { recursive: true });
		fs.copyFileSync(t.path, path.join(dest, 'main.i18n.json'));
	}

	return stageDir;
}

function readVibeVersion() {
	try {
		const productPath = path.join(ROOT, 'product.json');
		const json = JSON.parse(fs.readFileSync(productPath, 'utf8'));
		return json.vibeVersion ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

async function buildVsix(stageDir, locale, vibeVersion) {
	const { createVSIX } = require('@vscode/vsce');
	const outFile = path.join(ROOT, '.build', 'language-packs', `vibeide-language-pack-${locale}-${vibeVersion}.vsix`);
	await createVSIX({
		cwd: stageDir,
		packagePath: outFile,
		skipLicense: true,
		allowMissingRepository: true,
		allowStarActivation: true,
	});
	console.log(`[vibe-language-pack-build] VSIX created: ${path.relative(ROOT, outFile)}`);
	return outFile;
}

async function main() {
	const args = parseArgs(process.argv);
	if (args.help) { printHelp(); return; }

	const locale = validateLocale(args.locale);
	const vibeVersion = readVibeVersion();
	console.log(`[vibe-language-pack-build] locale=${locale} version=${vibeVersion}`);

	const translations = resolveTranslationSources(locale);
	const contribution = composeContribution(locale, translations);
	const stageDir = stageDirectory(locale, contribution, translations);
	console.log(`[vibe-language-pack-build] staged at ${path.relative(ROOT, stageDir)}`);

	if (args.stagingOnly) {
		console.log('[vibe-language-pack-build] --staging-only: stopping before VSIX zip step.');
		return;
	}

	await buildVsix(stageDir, locale, vibeVersion);
}

main().catch(err => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
