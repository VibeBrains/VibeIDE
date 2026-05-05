/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { join } from '../common/path.js';
import { existsSync, promises } from 'fs';
import { mark } from '../common/performance.js';
import { ILanguagePacks, INLSConfiguration } from '../../nls.js';
import { Promises } from './pfs.js';

export interface IResolveNLSConfigurationContext {

	/**
	 * Location where `nls.messages.json` and `nls.keys.json` are stored.
	 */
	readonly nlsMetadataPath: string;

	/**
	 * Path to the user data directory. Used as a cache for
	 * language packs converted to the format we need.
	 */
	readonly userDataPath: string;

	/**
	 * Commit of the running application. Can be `undefined`
	 * when not built.
	 */
	readonly commit: string | undefined;

	/**
	 * Locale as defined in `argv.json` or `app.getLocale()`.
	 */
	readonly userLocale: string;

	/**
	 * Locale as defined by the OS (e.g. `app.getPreferredSystemLanguages()`).
	 */
	readonly osLocale: string;
}

/**
 * Core translations shipped next to the app (extensions/vscode-language-pack-<locale>/translations/main.i18n.json).
 * Used before languagepacks.json is populated (first start) or as a fallback.
 */
function getBundledCoreTranslation(userLocale: string | undefined, nlsMetadataPath: string): { readonly path: string; readonly languageId: string } | undefined {
	if (!userLocale || userLocale === 'pseudo') {
		return undefined;
	}
	let locale = userLocale.toLowerCase();
	while (locale) {
		const candidate = join(nlsMetadataPath, '..', 'extensions', `vscode-language-pack-${locale}`, 'translations', 'main.i18n.json');
		if (existsSync(candidate)) {
			return { path: candidate, languageId: locale };
		}
		const index = locale.lastIndexOf('-');
		locale = index > 0 ? locale.substring(0, index) : '';
	}
	return undefined;
}

/**
 * Stable id for the built NLS flat-array shape. When `nls.keys` / `nls.messages` change
 * (e.g. after `npm run compile`) but `commit` stays the same, the cache under `clp/`
 * must not be reused or placeholders map to wrong strings and `{0}` stays literal.
 */
async function getNlsMetadataCacheSegment(nlsMetadataPath: string): Promise<string> {
	try {
		const [keys, messages] = await Promise.all([
			promises.readFile(join(nlsMetadataPath, 'nls.keys.json')),
			promises.readFile(join(nlsMetadataPath, 'nls.messages.json')),
		]);
		return createHash('sha256').update(keys).update(messages).digest('hex').slice(0, 16);
	} catch {
		return 'no-nls-metadata';
	}
}

export async function resolveNLSConfiguration({ userLocale, osLocale, userDataPath, commit, nlsMetadataPath }: IResolveNLSConfigurationContext): Promise<INLSConfiguration> {
	mark('code/willGenerateNls');

	if (userLocale === 'pseudo' || userLocale.startsWith('en')) {
		return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
	}

	if (!userDataPath) {
		return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
	}

	const bundledCore = getBundledCoreTranslation(userLocale, nlsMetadataPath);

	// Upstream also blocked `!commit && !bundledCore`. In VSCODE_DEV we still want to resolve
	// `languagepacks.json` (or rely on dev `product.commit` from git, see bootstrap-meta.ts).
	if (!bundledCore && !commit && !process.env['VSCODE_DEV']) {
		return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
	}

	try {
		const languagePacks = (await getLanguagePackConfigurations(userDataPath)) ?? {};

		let resolvedLanguage = resolveLanguagePackLanguage(languagePacks, userLocale);
		let languagePack = resolvedLanguage ? languagePacks[resolvedLanguage] : undefined;
		let mainLanguagePackPath = languagePack?.translations?.['vscode'];

		const packValid =
			Boolean(languagePack) &&
			typeof languagePack!.hash === 'string' &&
			Boolean(languagePack!.translations) &&
			typeof mainLanguagePackPath === 'string' &&
			(await Promises.exists(mainLanguagePackPath));

		if (!packValid) {
			if (!bundledCore) {
				return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
			}
			mainLanguagePackPath = bundledCore.path;
			resolvedLanguage = bundledCore.languageId;
			languagePack = {
				hash: 'vibeide-builtin',
				extensions: [],
				translations: { 'vscode': bundledCore.path },
				label: undefined,
			};
		}

		if (!resolvedLanguage || !languagePack || !mainLanguagePackPath) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		const languagePackId = `${languagePack.hash}.${resolvedLanguage}`;
		const globalLanguagePackCachePath = join(userDataPath, 'clp', languagePackId);
		const commitSegment = commit ?? 'no-commit';
		const nlsMetadataSegment = await getNlsMetadataCacheSegment(nlsMetadataPath);
		const commitLanguagePackCachePath = join(globalLanguagePackCachePath, `${commitSegment}-${nlsMetadataSegment}`);
		const languagePackMessagesFile = join(commitLanguagePackCachePath, 'nls.messages.json');
		const translationsConfigFile = join(globalLanguagePackCachePath, 'tcf.json');
		const languagePackCorruptMarkerFile = join(globalLanguagePackCachePath, 'corrupted.info');

		if (await Promises.exists(languagePackCorruptMarkerFile)) {
			await promises.rm(globalLanguagePackCachePath, { recursive: true, force: true, maxRetries: 3 }); // delete corrupted cache folder
		}

		const result: INLSConfiguration = {
			userLocale,
			osLocale,
			resolvedLanguage,
			defaultMessagesFile: join(nlsMetadataPath, 'nls.messages.json'),
			languagePack: {
				translationsConfigFile,
				messagesFile: languagePackMessagesFile,
				corruptMarkerFile: languagePackCorruptMarkerFile
			},

			// NLS: below properties are a relic from old times only used by vscode-nls and deprecated
			locale: userLocale,
			availableLanguages: { '*': resolvedLanguage },
			_languagePackId: languagePackId,
			_languagePackSupport: true,
			_translationsConfigFile: translationsConfigFile,
			_cacheRoot: globalLanguagePackCachePath,
			_resolvedLanguagePackCoreLocation: commitLanguagePackCachePath,
			_corruptedFile: languagePackCorruptMarkerFile
		};

		if (await Promises.exists(languagePackMessagesFile)) {
			touch(commitLanguagePackCachePath).catch(() => { }); // We don't wait for this. No big harm if we can't touch
			mark('code/didGenerateNls');
			return result;
		}

		const [
			nlsDefaultKeys,
			nlsDefaultMessages,
			nlsPackdata
		]:
			[Array<[string, string[]]>, string[], { contents: Record<string, Record<string, string>> }]
			//      ^moduleId ^nlsKeys                               ^moduleId      ^nlsKey ^nlsValue
			= await Promise.all([
				promises.readFile(join(nlsMetadataPath, 'nls.keys.json'), 'utf-8').then(content => JSON.parse(content)),
				promises.readFile(join(nlsMetadataPath, 'nls.messages.json'), 'utf-8').then(content => JSON.parse(content)),
				promises.readFile(mainLanguagePackPath, 'utf-8').then(content => JSON.parse(content)),
			]);

		const nlsResult: string[] = [];

		// We expect NLS messages to be in a flat array in sorted order as they
		// where produced during build time. We use `nls.keys.json` to know the
		// right order and then lookup the related message from the translation.
		// If a translation does not exist, we fallback to the default message.

		let nlsIndex = 0;
		for (const [moduleId, nlsKeys] of nlsDefaultKeys) {
			const moduleTranslations = nlsPackdata.contents[moduleId];
			for (const nlsKey of nlsKeys) {
				nlsResult.push(moduleTranslations?.[nlsKey] || nlsDefaultMessages[nlsIndex]);
				nlsIndex++;
			}
		}

		await promises.mkdir(commitLanguagePackCachePath, { recursive: true });

		await Promise.all([
			promises.writeFile(languagePackMessagesFile, JSON.stringify(nlsResult), 'utf-8'),
			promises.writeFile(translationsConfigFile, JSON.stringify(languagePack!.translations), 'utf-8')
		]);

		mark('code/didGenerateNls');

		return result;
	} catch (error) {
		console.error('Generating translation files failed.', error);
	}

	return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
}

/**
 * The `languagepacks.json` file is a JSON file that contains all metadata
 * about installed language extensions per language. Specifically, for
 * core (`vscode`) and all extensions it supports, it points to the related
 * translation files.
 *
 * The file is updated whenever a new language pack is installed or removed.
 */
async function getLanguagePackConfigurations(userDataPath: string): Promise<ILanguagePacks | undefined> {
	const configFile = join(userDataPath, 'languagepacks.json');
	try {
		return JSON.parse(await promises.readFile(configFile, 'utf-8'));
	} catch (err) {
		return undefined; // Do nothing. If we can't read the file we have no language pack config.
	}
}

function resolveLanguagePackLanguage(languagePacks: ILanguagePacks, locale: string | undefined): string | undefined {
	try {
		while (locale) {
			if (languagePacks[locale]) {
				return locale;
			}

			const index = locale.lastIndexOf('-');
			if (index > 0) {
				locale = locale.substring(0, index);
			} else {
				return undefined;
			}
		}
	} catch (error) {
		console.error('Resolving language pack configuration failed.', error);
	}

	return undefined;
}

function defaultNLSConfiguration(userLocale: string, osLocale: string, nlsMetadataPath: string): INLSConfiguration {
	mark('code/didGenerateNls');

	return {
		userLocale,
		osLocale,
		resolvedLanguage: 'en',
		defaultMessagesFile: join(nlsMetadataPath, 'nls.messages.json'),

		// NLS: below 2 are a relic from old times only used by vscode-nls and deprecated
		locale: userLocale,
		availableLanguages: {}
	};
}

//#region fs helpers

function touch(path: string): Promise<void> {
	const date = new Date();

	return promises.utimes(path, date, date);
}

//#endregion
