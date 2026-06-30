/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeNlsBundleService — runtime hookup for the i18n fallback chain.
 *
 * Loads `vibeide.nls.<locale>.json` from the compiled output directory at
 * first use and delegates all string resolution to the pure `resolveLocalized`
 * helper from `common/i18nFallbackChain.ts`.
 *
 * This intentionally avoids the compile-time `nls.localize()` path — it is
 * used for strings that originate outside the TypeScript source (e.g. dynamic
 * labels loaded from metadata JSON, LLM-generated summaries that need a
 * locale-specific prefix, etc).
 *
 * (roadmap §L491 — bundle-loader hookup)
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { language as platformLanguage } from '../../../../base/common/platform.js';
import {
	resolveLocalized,
	LocaleBundle,
	ResolveLocalizedResult,
} from '../common/i18nFallbackChain.js';

export const IVibeNlsBundleService = createDecorator<IVibeNlsBundleService>('vibeNlsBundleService');

export interface IVibeNlsBundleService {
	readonly _serviceBrand: undefined;

	/**
	 * Resolve a vibeide string through the fallback chain:
	 *   requestedLocale → base-locale → englishDefault → key.
	 * Lazy-loads the bundle on first call (non-blocking on subsequent calls).
	 */
	resolve(key: string, englishDefault?: string): Promise<ResolveLocalizedResult>;
}

class VibeNlsBundleService extends Disposable implements IVibeNlsBundleService {
	declare readonly _serviceBrand: undefined;

	private _bundles: LocaleBundle[] | undefined;
	private _loadPromise: Promise<void> | undefined;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
	}

	async resolve(key: string, englishDefault?: string): Promise<ResolveLocalizedResult> {
		if (!this._bundles) {
			if (!this._loadPromise) {
				this._loadPromise = this._loadBundles();
			}
			await this._loadPromise;
		}
		return resolveLocalized({
			key,
			englishDefault,
			requestedLocale: platformLanguage,
			bundles: this._bundles ?? [],
		});
	}

	private async _loadBundles(): Promise<void> {
		const locale = platformLanguage;
		// Normalise to lowercase-dash form (e.g. "ru-RU" → "ru-ru").
		const tag = locale.toLowerCase().replace(/_/g, '-');

		const candidates = [tag];
		const dashIdx = tag.indexOf('-');
		if (dashIdx !== -1) { candidates.push(tag.slice(0, dashIdx)); } // base locale

		// In Electron/Node: process.cwd() is the app working directory.
		// In web: no bundle file is available on disk — return empty and rely on englishDefault fallback.
		const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : null;
		if (!cwd) {
			this._bundles = [];
			return;
		}
		const outRoot = URI.file(cwd);
		const bundles: LocaleBundle[] = [];

		for (const candidateTag of candidates) {
			const bundleUri = URI.joinPath(outRoot, 'out', `vibeide.nls.${candidateTag}.json`);
			try {
				const content = await this._fileService.readFile(bundleUri);
				const raw: Record<string, string> = JSON.parse(content.value.toString());
				bundles.push({ localeTag: candidateTag, entries: new Map(Object.entries(raw)) });
				this._log.trace(`[VibeNlsBundle] Loaded locale bundle: ${candidateTag} (${Object.keys(raw).length} keys)`);
			} catch {
				// Bundle missing or unreadable — continue to next fallback.
			}
		}

		this._bundles = bundles;
		if (bundles.length === 0) {
			this._log.trace(`[VibeNlsBundle] No locale bundles found for ${locale} — will use englishDefault/key fallbacks`);
		}
	}
}

registerSingleton(IVibeNlsBundleService, VibeNlsBundleService, InstantiationType.Delayed);
